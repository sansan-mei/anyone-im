#!/usr/bin/env bash
set -euo pipefail
# This script creates disposable resources ONLY on a GitHub-hosted CI runner.
# It must never be used as a production deployment script.
if [[ "${GITHUB_ACTIONS:-}" != "true" || -z "${RUNNER_TEMP:-}" ]]; then
  printf '%s\n' 'Refusing container smoke test outside GitHub Actions.' >&2
  exit 2
fi
image="${1:-relay-im:ci}"
work="$(mktemp -d "${RUNNER_TEMP}/anyone-container.XXXXXX")"
prefix="anyone-ci-$(basename "$work" | tr '[:upper:]' '[:lower:]')"
network_id='' db_id='' app_id='' data_volume='' uploads_volume=''
cleanup() {
  code=$?
  if [[ $code -ne 0 && -n "$app_id" ]]; then docker logs --tail 100 "$app_id" >&2 || true; fi
  if [[ -n "$app_id" ]]; then docker rm -f "$app_id" >/dev/null 2>&1 || true; fi
  if [[ -n "$db_id" ]]; then docker rm -f "$db_id" >/dev/null 2>&1 || true; fi
  if [[ -n "$network_id" ]]; then docker network rm "$network_id" >/dev/null 2>&1 || true; fi
  if [[ -n "$data_volume" ]]; then docker volume rm "$data_volume" >/dev/null 2>&1 || true; fi
  if [[ -n "$uploads_volume" ]]; then docker volume rm "$uploads_volume" >/dev/null 2>&1 || true; fi
  rm -rf -- "$work"
  exit "$code"
}
trap cleanup EXIT
network_id="$(docker network create "${prefix}-net")"
for suffix in database uploads; do
  if docker volume inspect "${prefix}-${suffix}" >/dev/null 2>&1; then
    printf '%s\n' 'Refusing to reuse an existing CI volume.' >&2
    exit 2
  fi
done
data_volume="$(docker volume create "${prefix}-database")"
uploads_volume="$(docker volume create "${prefix}-uploads")"
db_id="$(docker run -d --network "$network_id" --network-alias db \
  --memory 768m -v "${data_volume}:/var/lib/mysql" \
  -e MYSQL_DATABASE=relay_ci -e MYSQL_USER=relay \
  -e MYSQL_PASSWORD=ci_smoke_only -e MYSQL_ROOT_PASSWORD=ci_smoke_root_only \
  mysql:8.4 --innodb-buffer-pool-size=128M --performance-schema=OFF --max-connections=30)"
for attempt in {1..90}; do
  if docker exec "$db_id" mysqladmin ping -h 127.0.0.1 --silent >/dev/null 2>&1; then break; fi
  if [[ "$attempt" == 90 ]]; then docker logs "$db_id" >&2; exit 1; fi
  sleep 1
done
runtime_env=(
  -e NODE_ENV=production -e DB_PROVIDER=mysql
  -e DATABASE_URL=mysql://relay:ci_smoke_only@db:3306/relay_ci
  -e DATA_DIR=/data -e HOST=0.0.0.0 -e PORT=4100
  -e PUBLIC_ORIGIN=https://im.example.test
)
docker run --rm --network "$network_id" "${runtime_env[@]}" \
  -v "${uploads_volume}:/data" "$image" bun run db:push
app_id="$(docker run -d --init --network "$network_id" "${runtime_env[@]}" \
  -p 127.0.0.1::4100 -v "${uploads_volume}:/data" "$image")"
wait_ready() {
  for attempt in {1..60}; do
    if docker exec "$app_id" bun -e 'const r=await fetch("http://127.0.0.1:4100/readyz");process.exit(r.ok?0:1)' >/dev/null 2>&1; then return; fi
    sleep 1
  done
  return 1
}
wait_ready
# The first process verifies real production cookies, MySQL persistence and
# non-root writes to a fresh Docker named volume. Its session stays off logs.
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
  const form=new FormData();
  form.append("file",new File([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cWQAAAAASUVORK5CYII=","base64")],"smoke.png",{type:"image/png"}));
  const uploaded=await fetch(base+"/api/rooms/"+room.id+"/attachments",{method:"POST",headers,body:form});
  assert(uploaded.ok,"Non-root named-volume upload failed: "+uploaded.status);
  const attachment=(await uploaded.json()).data;
  const message=await json("/api/rooms/"+room.id+"/messages",{clientMessageId:crypto.randomUUID(),text:"Persist across container restart",attachmentId:attachment.id});
  const file=await fetch(base+attachment.url,{headers});assert(file.ok,"Authorized upload cannot be read");
  const html=await fetch(base+"/");assert(html.ok&&(await html.text()).includes("/assets/"),"Built UI missing");
  console.log(JSON.stringify({cookie,userId:user.id,roomId:room.id,messageId:message.id,attachmentUrl:attachment.url}));
' > "$work/session.json"
docker restart "$app_id" >/dev/null
wait_ready
docker exec -i "$app_id" bun -e '
  const state=await Bun.stdin.json(),base="http://127.0.0.1:4100";
  const headers={Cookie:state.cookie,"X-Anyone-User-Id":state.userId};
  const messages=await fetch(base+"/api/rooms/"+state.roomId+"/messages",{headers});
  if(!messages.ok||(await messages.json()).data.messages.every(m=>m.id!==state.messageId))throw Error("Message/session did not survive restart");
  const attachment=await fetch(base+state.attachmentUrl,{headers});
  if(!attachment.ok||(await attachment.arrayBuffer()).byteLength===0)throw Error("Named-volume attachment did not survive restart");
  console.log("Container smoke passed: nonroot, MySQL, Secure cookie, named-volume upload and restart persistence.");
' < "$work/session.json"
