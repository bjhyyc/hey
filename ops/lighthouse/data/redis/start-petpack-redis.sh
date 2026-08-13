#!/usr/bin/env bash
set -Eeuo pipefail

redis_password="$(cat /run/secrets/redis_password)"
umask 077
mkdir -p /run/petpack-redis
printf 'user default off\nuser petpack on >%s ~* &* +@all\n' "$redis_password" \
  > /run/petpack-redis/users.acl
chown -R redis:redis /run/petpack-redis
unset redis_password

exec docker-entrypoint.sh redis-server \
  /usr/local/etc/redis/redis.conf \
  --aclfile /run/petpack-redis/users.acl
