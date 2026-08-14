#!/usr/bin/env bash
set -Eeuo pipefail

redis_password="$(cat /run/secrets/redis_password)"
redis_key_prefix="${PETPACK_REDIS_KEY_PREFIX:-petpack}"
if [[ ! "$redis_key_prefix" =~ ^[A-Za-z0-9_-]{1,32}$ ]]; then
  printf 'PETPACK_REDIS_KEY_PREFIX is invalid.\n' >&2
  exit 1
fi
umask 077
mkdir -p /run/petpack-redis
printf 'user default off\nuser petpack on >%s ~%s:* &%s:* +@all -acl -bgsave -client|kill -config -debug -flushall -flushdb -migrate -module -monitor -replicaof -save -shutdown -slaveof\n' \
  "$redis_password" "$redis_key_prefix" "$redis_key_prefix" \
  > /run/petpack-redis/users.acl
chown -R redis:redis /run/petpack-redis
unset redis_password redis_key_prefix

exec docker-entrypoint.sh redis-server \
  /usr/local/etc/redis/redis.conf \
  --aclfile /run/petpack-redis/users.acl
