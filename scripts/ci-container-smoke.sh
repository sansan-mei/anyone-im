#!/usr/bin/env bash
set -euo pipefail
# This script creates disposable resources ONLY on a GitHub-hosted CI runner.
# It must never be used as a production deployment script.
if [[ "${GITHUB_ACTIONS:-}" != "true" || -z "${RUNNER_TEMP:-}" ]]; then
  printf '%s\n' 'Refusing container smoke test outside GitHub Actions.' >&2
  exit 2
fi
image="${1:-anyone-im:ci}"
work="$(mktemp -d "${RUNNER_TEMP}/anyone-container.XXXXXX")"
prefix="anyone-ci-$(basename "$work" | tr '[:upper:]' '[:lower:]')"
network_id='' db_id='' app_id='' data_volume=''
cleanup() {
  code=$?
  if [[ $code -ne 0 && -n "$app_id" ]]; then docker logs --tail 100 "$app_id" >&2 || true; fi
  if [[ -n "$app_id" ]]; then docker rm -f "$app_id" >/dev/null 2>&1 || true; fi
  if [[ -n "$db_id" ]]; then docker rm -f "$db_id" >/dev/null 2>&1 || true; fi
  if [[ -n "$network_id" ]]; then docker network rm "$network_id" >/dev/null 2>&1 || true; fi
  if [[ -n "$data_volume" ]]; then docker volume rm "$data_volume" >/dev/null 2>&1 || true; fi

  rm -rf -- "$work"
  exit "$code"
}
trap cleanup EXIT
network_id="$(docker network create "${prefix}-net")"
if docker volume inspect "${prefix}-database" >/dev/null 2>&1; then
  printf '%s\n' 'Refusing to reuse an existing CI volume.' >&2
  exit 2
fi
data_volume="$(docker volume create "${prefix}-database")"
db_id="$(docker run -d --network "$network_id" --network-alias db \
  --memory 768m -v "${data_volume}:/var/lib/mysql" \
  -e MYSQL_DATABASE=anyone_ci -e MYSQL_USER=anyone \
  -e MYSQL_PASSWORD=ci_smoke_only -e MYSQL_ROOT_PASSWORD=ci_smoke_root_only \
  mysql:8.4 --innodb-buffer-pool-size=128M --performance-schema=OFF --max-connections=30)"
for attempt in {1..90}; do
  if docker exec "$db_id" mysqladmin ping -h 127.0.0.1 --silent >/dev/null 2>&1; then break; fi
  if [[ "$attempt" == 90 ]]; then docker logs "$db_id" >&2; exit 1; fi
  sleep 1
done
runtime_env=(
  -e NODE_ENV=production -e DB_PROVIDER=mysql
  -e DATABASE_URL=mysql://anyone:ci_smoke_only@db:3306/anyone_ci
  -e DATA_DIR=/proc/anyone-im-unused -e HOST=0.0.0.0 -e PORT=4100
  -e PUBLIC_ORIGIN=https://im.example.test
)
docker run --rm --network "$network_id" "${runtime_env[@]}" "$image" bun run db:push
start_app() {
  app_id="$(docker run -d --init --network "$network_id" "${runtime_env[@]}" \
    -p 127.0.0.1::4100 "$image")"
  if [[ "$(docker inspect --format '{{len .Mounts}}' "$app_id")" != 0 ]]; then
    printf '%s\n' 'Application container must not mount any data volumes.' >&2
    exit 1
  fi
}
start_app
wait_ready() {
  for attempt in {1..60}; do
    if docker exec "$app_id" bun -e 'const r=await fetch("http://127.0.0.1:4100/readyz");process.exit(r.ok?0:1)' >/dev/null 2>&1; then return; fi
    sleep 1
  done
  return 1
}
wait_ready
# The first process verifies production cookies and a maximum-size MySQL blob.
# DATA_DIR deliberately cannot be created. Session state stays off logs.
docker exec "$app_id" bun -e '
  const assert=(v,m)=>{if(!v)throw Error(m)};
  assert(process.getuid()!==0,"App must not run as root");
  const base="http://127.0.0.1:4100",origin="https://im.example.test";
  const guest=await fetch(base+"/api/auth/guest",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({displayName:"Container smoke"})});
  assert(guest.ok,"Guest session failed");
  const user=(await guest.json()).data.user;
  const cookieHeader=guest.headers.get("set-cookie")||"";
  assert(/HttpOnly/i.test(cookieHeader)&&/Secure/i.test(cookieHeader),"Production cookie flags missing");
  const cookie=cookieHeader.split(";")[0];
  const headers={Origin:origin,Cookie:cookie,"X-Anyone-User-Id":user.id};
  const json=async(path,body)=>{const r=await fetch(base+path,{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify(body)});assert(r.ok,"POST failed: "+path+" "+r.status);return(await r.json()).data};
  const room=await json("/api/rooms",{name:"Container runtime",description:"CI only",visibility:"private"});
  const {MAX_ATTACHMENT_BYTES}=await import("./packages/contracts/src/index.ts");
  assert(MAX_ATTACHMENT_BYTES===10*1024*1024,"Image limit must be 10 MiB");
  const png=Buffer.alloc(MAX_ATTACHMENT_BYTES);
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cWQAAAAASUVORK5CYII=","base64").copy(png);
  const form=new FormData();
  const oversized=Buffer.alloc(MAX_ATTACHMENT_BYTES+1);png.copy(oversized);
  form.set("file",new File([oversized],"oversized.png",{type:"image/png"}));
  const rejected=await fetch(base+"/api/rooms/"+room.id+"/attachments",{method:"POST",headers,body:form});
  assert(rejected.status===413,"10 MiB + 1 byte must be rejected");
  form.set("file",new File([png],"smoke.png",{type:"image/png"}));
  const uploaded=await fetch(base+"/api/rooms/"+room.id+"/attachments",{method:"POST",headers,body:form});
  assert(uploaded.ok,"Maximum-size database upload failed: "+uploaded.status);
  const attachment=(await uploaded.json()).data;
  assert(attachment.size===png.length&&!Object.hasOwn(attachment,"bytes"),"Attachment must contain metadata only");
  const message=await json("/api/rooms/"+room.id+"/messages",{clientMessageId:crypto.randomUUID(),text:"Persist across container replacement",attachmentId:attachment.id});
  const file=await fetch(base+attachment.url,{headers});assert(file.ok,"Authorized upload cannot be read");
  assert(Buffer.from(await file.arrayBuffer()).equals(png),"Uploaded bytes differ");
  const sha256=Buffer.from(await crypto.subtle.digest("SHA-256",png)).toString("hex");
  const html=await fetch(base+"/");assert(html.ok&&(await html.text()).includes("/assets/"),"Built UI missing");
  console.log(JSON.stringify({cookie,userId:user.id,roomId:room.id,messageId:message.id,attachmentUrl:attachment.url,size:png.length,sha256}));
' > "$work/session.json"
# Remove the old writable layer, not merely restart its process/container.
docker rm -f "$app_id" >/dev/null
app_id=''
start_app
wait_ready
docker exec -i "$app_id" bun -e '
  const state=await Bun.stdin.json(),base="http://127.0.0.1:4100";
  const headers={Cookie:state.cookie,"X-Anyone-User-Id":state.userId};
  const messages=await fetch(base+"/api/rooms/"+state.roomId+"/messages",{headers});
  if(!messages.ok||(await messages.json()).data.messages.every(m=>m.id!==state.messageId))throw Error("Message/session did not survive replacement");
  const attachment=await fetch(base+state.attachmentUrl,{headers});
  if(!attachment.ok)throw Error("Database attachment did not survive replacement");
  const bytes=await attachment.arrayBuffer();
  const sha256=Buffer.from(await crypto.subtle.digest("SHA-256",bytes)).toString("hex");
  if(bytes.byteLength!==state.size||sha256!==state.sha256)throw Error("Replacement attachment bytes differ");
  console.log("Container smoke passed: nonroot, MySQL, Secure cookie, 10 MiB boundary, no app volumes, exact attachment bytes after fresh-container replacement.");
' < "$work/session.json"
