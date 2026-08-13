# Lighthouse data services

This directory deploys the PetPack Studio staging PostgreSQL and Redis services
onto the existing Lighthouse host. Neither database publishes a host port. API
and worker containers must join the internal `petpack-data` Docker network and
use TLS service names `postgres:5432` and `redis:6379`.

Server-generated credentials and private keys live only under
`/opt/petpack/config/data/{secrets,tls}` and must never be copied back into Git.
PostgreSQL migrations are checksum tracked. A changed applied migration fails
closed rather than being silently rerun.

Daily local PostgreSQL backups run at 03:20 Asia/Shanghai and retain seven days.
The bootstrap performs a real scratch-database restore before reporting success.
An encrypted off-host COS copy is added only after the least-privilege CAM service
identity is configured.
