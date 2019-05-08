#!/bin/sh

set -euxo pipefail

# PVC mount and folder variables, removing any trailing slashes (%/)
#
SRC_MNT=${SRC_MNT:-/mnt/source}
DEST_MNT=${DEST_MNT:-/mnt/dest}
SRC_MNT=${SRC_MNT%/}
DEST_MNT=${DEST_MNT%/}


# Copy and verify


# Check if NFS repository is initialized.  If not, initialize it.
# RESTIC_PASSWORD is required.
if ! restic -r ${DEST_MNT}/backups/ snapshots
then
  restic -r ${DEST_MNT}/backups/ init
fi

# check integrity of previous backups
if ! restic -r ${DEST_MNT}/backups/ check
then
	echo "Copy failed!  Previous backups retained."
  curl -X POST -H 'Content-Type: application/json' --data '{"username":"BakBot","icon_emoji":":robot:","text":"Backup for EPIC Minio files FAILURE! Backups are paused until the issue is addressed. Please see documentation: "}' https://chat.pathfinder.gov.bc.ca/hooks/BTqW65kZWWrs3TnDt/Yz9QocenFmpuWyqr3Xapgo9c3X4wm8RBfdnizej7gqeBqfN3
	exit 1
fi

# check disk usage on backup pod here

# Backup files using delta (de-duplicate) and encryption
restic --cache-dir ${DEST_DIR}/.cache -r ${DEST_MNT}/backups/ backup ${SRC_MNT}

# check repository integrity before exiting
if ! restic -r ${DEST_MNT}/backups/ check
then
	echo "Copy failed!  Previous backups retained."
  curl -X POST -H 'Content-Type: application/json' --data '{"username":"BakBot","icon_emoji":":robot:","text":"Backup for EPIC Minio files FAILURE! Backups are paused until the issue is addressed. Please see documentation: "}' https://chat.pathfinder.gov.bc.ca/hooks/BTqW65kZWWrs3TnDt/Yz9QocenFmpuWyqr3Xapgo9c3X4wm8RBfdnizej7gqeBqfN3
	exit 1
else

  # Clean up old snapshots.
  # As an example, the following arguments:
  # --keep-last 5 --keep-daily 7 --keep-weekly 5 --keep-monthly 12 --keep-yearly 2
  # will keep the most recent 5 due to the size of the folder and space limitations on openshift
  # The rest will be pruned.
  restic -r ${DEST_MNT}/backups/ forget --keep-last 5 --prune

  echo "Backup Success!"
  curl -X POST -H 'Content-Type: application/json' --data '{"username":"BakBot","icon_emoji":":robot:","text":"Backup for EPIC Minio files SUCCESS!"}' https://chat.pathfinder.gov.bc.ca/hooks/BTqW65kZWWrs3TnDt/Yz9QocenFmpuWyqr3Xapgo9c3X4wm8RBfdnizej7gqeBqfN3
fi
