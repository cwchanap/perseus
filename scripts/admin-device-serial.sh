#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat <<'EOF'
Usage:
  scripts/admin-device-serial.sh --set-pulumi-secret
  scripts/admin-device-serial.sh --print-json
  scripts/admin-device-serial.sh --print-serial

Options:
  --set-pulumi-secret  Set the current Mac serial as the Pulumi secret adminDeviceSerials.
                       This replaces the current JSON array with this device only.
  --print-json         Print the current Mac serial as a JSON array string.
  --print-serial       Print the raw current Mac serial.
  -h, --help           Show this help.

The set mode does not print the serial number. To add multiple trusted devices, collect
their serials with --print-serial or --print-json, then set adminDeviceSerials to a JSON
array containing every trusted serial number.
EOF
}

get_mac_serial() {
	local serial
	serial=$(/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice \
		| /usr/bin/awk -F'"' '/IOPlatformSerialNumber/ { print $4; exit }')

	if [[ -z "$serial" ]]; then
		serial=$(/usr/sbin/system_profiler SPHardwareDataType \
			| /usr/bin/awk -F': ' '/Serial Number/ { print $2; exit }')
	fi

	if [[ -z "$serial" ]]; then
		echo "Unable to detect this Mac serial number." >&2
		exit 1
	fi

	printf '%s' "$serial"
}

json_escape() {
	/usr/bin/sed 's/\\/\\\\/g; s/"/\\"/g'
}

mode="${1:-}"
case "$mode" in
	--set-pulumi-secret | --print-json | --print-serial)
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	"")
		usage
		exit 2
		;;
	*)
		echo "Unknown option: $mode" >&2
		usage >&2
		exit 2
		;;
esac

if [[ "$#" -ne 0 ]]; then
	echo "Unexpected arguments: $*" >&2
	usage >&2
	exit 2
fi

serial="$(get_mac_serial)"
escaped_serial="$(printf '%s' "$serial" | json_escape)"
serial_json="[\"$escaped_serial\"]"

case "$mode" in
	--print-serial)
		printf '%s\n' "$serial"
		;;
	--print-json)
		printf '%s\n' "$serial_json"
		;;
	--set-pulumi-secret)
		repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
		cd "$repo_root/packages/infrastructure"
		pulumi config set --secret adminDeviceSerials "$serial_json"
		echo "Set Pulumi secret adminDeviceSerials for the current device."
		;;
esac
