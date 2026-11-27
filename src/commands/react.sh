# react.sh "emoji" [message id] [channel id]: add a reaction (custom emoji as name:id).
emoji=$(jq -rn --arg e "$1" '$e|@uri')
discord PUT "/channels/${3:-$CHANNEL}/messages/${2:-$MESSAGE}/reactions/$emoji/@me" > /dev/null && echo "reacted $1"
