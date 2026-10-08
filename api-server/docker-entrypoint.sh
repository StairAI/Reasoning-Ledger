#!/bin/sh
# Entrypoint of the server image (see "Running the published image" in
# api-server/README.md). The first argument picks what the container does:
#
#   start    the default: migrate, then serve, in one container
#   migrate  bring the database to the current schema, re-apply the runtime
#            account's privileges, and exit. Connects with MIGRATION_DATABASE_URL
#            (falling back to DATABASE_URL); set RL_RUNTIME_ROLE to the role the
#            server connects as (scripts/db-deploy.mts)
#   serve    run the server only, connected with DATABASE_URL. The server never
#            sees MIGRATION_DATABASE_URL, so a deployment can give the
#            long-running process the runtime account's credentials alone
#   other    anything else runs as given, as the container's user (for example
#            `sh` to look around, or an operator command)
#
# Started as root (the image default), it hands the content directory to an
# unprivileged user and re-runs itself as that user, so nothing from the
# application runs as root. When it cannot switch users, or cannot give the
# content directory to that user (the container's capabilities were dropped),
# it says so once and runs as root, as earlier images did. Started as any other
# user (`docker run --user`), it runs as that user, and the content directory
# must already be writable.
#
# Environment read here, besides what the server and db:deploy read:
#   CONTENT_DIR  where uploaded content is stored, resolved as the server does:
#                default data/content, a relative path taken from RL_APP_DIR
#   RL_APP_DIR   the workspace root that holds api-server/, and the server's
#                working directory (default /app)
#   RL_USER      the user to run as when started as root (default rl)

set -eu

app_dir=${RL_APP_DIR:-/app}
run_as=${RL_USER:-rl}

log() {
  printf 'entrypoint: %s\n' "$*" >&2
}

die() {
  log "error: $*"
  exit 1
}

# The content directory as the server resolves CONTENT_DIR from its working
# directory. It is not exported, so the server sees the same environment as
# `docker exec` and any other command in the container.
resolve_content_dir() {
  content_dir=${CONTENT_DIR:-data/content}
  case $content_dir in
    /*) ;;
    *) content_dir=$app_dir/$content_dir ;;
  esac
}

as_server_user() {
  setpriv --reuid="$uid" --regid="$gid" --clear-groups -- "$@"
}

# As root: make sure the content directory exists and that the server's user
# can write it. A fresh bind mount is usually owned by root, and so is content
# written by an image that ran as root. Only directories change owner: the
# store adds an object by renaming a new temporary file into place and removes
# one by deleting it, which needs write access to the directory alone, and it
# never writes to an existing object (those stay readable as they are). The
# directories are the store and one per owner, so this takes one listing of
# the store however many objects it holds. Returns non-zero, with a warning,
# when the user still cannot write there.
own_content_dir() {
  mkdir -p "$content_dir" || die "cannot create CONTENT_DIR $content_dir"
  if [ -z "$(find -H "$content_dir" -maxdepth 1 -type d ! -user "$uid" -print -quit)" ]; then
    return 0
  fi
  log "giving $content_dir and its directories to $run_as (uid $uid)"
  if err=$(find -H "$content_dir" -maxdepth 1 -type d ! -user "$uid" \
    -exec chown "$uid:$gid" {} + 2>&1); then
    return 0
  fi
  err=$(printf '%s\n' "$err" | head -n 1)
  # Some network filesystems refuse a change of owner but let the user write.
  if unwritable=$(as_server_user find -H "$content_dir" -maxdepth 1 -type d \
    \( ! -writable -o ! -executable \) -print -quit 2>/dev/null) &&
    [ -z "$unwritable" ]; then
    log "could not change the owner of $content_dir ($err), but $run_as can write there"
    return 0
  fi
  log "warning: cannot give $content_dir to $run_as (uid $uid): $err." \
    "Running as root, as earlier images did. To run as $run_as, keep the CHOWN" \
    "capability, or make the directory and its subdirectories writable for uid $uid"
  return 1
}

# Fail before migrating or listening when uploads could not be stored.
check_content_dir() {
  mkdir -p "$content_dir" || die "cannot create CONTENT_DIR $content_dir as uid $(id -u)"
  probe=$(mktemp "$content_dir/.write-check.XXXXXX" 2>/dev/null) ||
    die "CONTENT_DIR $content_dir is not writable by uid $(id -u); mount a writable volume there, or give it to this user"
  rm -f "$probe"
}

check_database_url() {
  [ -n "${DATABASE_URL:-}" ] ||
    die "DATABASE_URL is not set; the server connects with it (the runtime account)"
}

migrate() {
  if [ -n "${MIGRATION_DATABASE_URL:-}" ] &&
    [ "${MIGRATION_DATABASE_URL}" != "${DATABASE_URL:-}" ] &&
    [ -z "${RL_RUNTIME_ROLE:-}" ]; then
    log "RL_RUNTIME_ROLE is not set, so the runtime account's privileges are not re-applied after migrating"
  fi
  log "migrating the database"
  (cd "$app_dir" && pnpm --filter "{./api-server}" db:deploy)
}

serve() {
  unset MIGRATION_DATABASE_URL
  cd "$app_dir"
  log "starting the server on ${HOST:-localhost}:${PORT:-4321}, content in $content_dir"
  exec node api-server/dist/server/entry.mjs
}

if [ $# -eq 0 ]; then
  set -- start
fi
mode=$1

case $mode in
  start | migrate | serve)
    [ $# -eq 1 ] || die "$mode takes no arguments"
    ;;
  *)
    exec "$@"
    ;;
esac

resolve_content_dir

if [ "$(id -u)" -eq 0 ]; then
  uid=$(id -u "$run_as" 2>/dev/null) || die "user $run_as does not exist"
  gid=$(id -g "$run_as")
  [ "$uid" -ne 0 ] || die "RL_USER must not be root"
  # Try the switch with a harmless command first: it fails without the SETUID
  # and SETGID capabilities, or where the uid is not mapped into the container.
  if ! err=$(as_server_user true 2>&1); then
    err=$(printf '%s\n' "${err:-setpriv failed}" | head -n 1)
    log "warning: cannot switch to $run_as (uid $uid): $err." \
      "Running as root, as earlier images did. To run as $run_as, keep the" \
      "SETUID, SETGID and CHOWN capabilities, or start the container with --user $uid"
  elif [ "$mode" = migrate ] || own_content_dir; then
    HOME=$(getent passwd "$run_as" | cut -d: -f6)
    export HOME
    exec setpriv --reuid="$uid" --regid="$gid" --clear-groups -- sh "$0" "$@"
  fi
fi

case $mode in
  start)
    check_database_url
    check_content_dir
    migrate
    serve
    ;;
  migrate)
    migrate
    ;;
  serve)
    check_database_url
    check_content_dir
    serve
    ;;
esac
