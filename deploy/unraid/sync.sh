#!/bin/bash
#description=Pretty Please Print: poll Bambuddy and move tickets along
#arrayStarted=true
#
# The Bambuddy sync for Pretty Please Print, as an Unraid User Scripts entry.
#
# User Scripts -> Add New Script -> paste this in, then set the schedule to
# Custom: */5 * * * *
#
# It runs the call from inside the app container, so CRON_SECRET is read from
# the container's own environment and never written into this script, and the
# sync route doesn't need to be reachable from outside (the SWAG conf blocks
# it). It prints {"processed": n}, the number of open tickets it looked at.

if [ "$(docker inspect -f '{{.State.Running}}' ppp-app 2>/dev/null)" != "true" ]; then
  echo "ppp-app isn't running; nothing to sync."
  exit 0
fi

docker exec ppp-app node -e '
fetch("http://127.0.0.1:3000/api/cron/sync", {
  method: "POST",
  headers: { authorization: "Bearer " + process.env.CRON_SECRET },
})
  .then(async (r) => {
    console.log(r.status, await r.text());
    process.exit(r.ok ? 0 : 1);
  })
  .catch((e) => {
    console.error("sync failed:", e.message);
    process.exit(1);
  });
'
