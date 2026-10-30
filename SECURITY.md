# Security notes

This is a single-process, small-group chat implementation, not an end-to-end encrypted messenger. Operators and database administrators can read stored messages and attachments.

## Boundaries

- Server-owned users and opaque hashed HttpOnly cookie sessions; never trust client sender/role fields.
- Membership on every protected operation and outgoing recipient; invite hashes, expiry/revocation and durable kicks.
- Database commit before message acknowledgement/broadcast, immutable client-id dedupe and cursor recovery.
- Same-origin mutation/handshake checks and bounded HTTP/socket/multipart input; public TLS remains the operator's responsibility.
- Private random disk keys, image MIME/signature/size checks, no public upload directory; not a malware scanner.
- Process-local rate limits and presence; no claim of distributed revocation or transactional outbox.

Runtime and generated-client changes must pass database generation/push, real transport tests, type checks, browser E2E and dependency audit. The root deepmerge-ts8.0.2 override repairs GHSA-ggr8-5vv4-36mx in Prisma6 CLI's pinned dependency. It is not an ignored advisory; compatibility is tested through Prisma operations.

## Reporting

Do not publish session tokens, passwords, private room invite links, database dumps or uploaded user files in issues. Report a security problem privately to the repository owner. Development test data is synthetic and isolated; production credentials are never needed for the automated suite.

Before public deployment: configure HTTPS, resource limits, capacity monitoring, consistent backups and data-retention/garbage-collection policy. Old-site SSO and migration must not bypass the new room ACLs.
