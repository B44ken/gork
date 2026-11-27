# reply.sh "text" [message id]: reply in $CHANNEL to the message (default $MESSAGE), without pinging anyone.
jq -n --arg c "$1" --arg m "${2:-$MESSAGE}" \
  '{content: $c, message_reference: {message_id: $m, fail_if_not_exists: false}, allowed_mentions: {parse: []}}' \
  | discord POST "/channels/$CHANNEL/messages" | jq -r '"sent message " + .id'
