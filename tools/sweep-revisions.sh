#!/usr/bin/env bash
#
# sweep-revisions.sh — free Cloud Run CPU quota by deleting old 0%-traffic revisions.
#
# Cloud Functions (2nd gen) run on Cloud Run. Every deploy leaves the previous
# revision behind, and each idle revision still reserves CPU capacity — they pile
# up until the regional "total allowable CPU per project" quota is exceeded.
#
# For each Cloud Run SERVICE this keeps the revision currently serving traffic and
# deletes the rest. It iterates `gcloud run services` (Cloud Run services) — NOT
# IAM service accounts.
#
# DRY-RUN by default (prints "WOULD delete X", deletes nothing).
# Pass --delete to actually delete.
#
# Usage:
#   ./sweep-revisions.sh            # dry-run — safe, deletes nothing
#   ./sweep-revisions.sh --delete   # real deletion (after reviewing the dry-run)
#
# Override target (defaults to Winemaster) via env:
#   PROJECT=hawks-mygames-live REGION=us-central1 ./sweep-revisions.sh
#
set -euo pipefail

PROJECT="${PROJECT:-winemaster-mygames-live}"
REGION="${REGION:-us-central1}"

DELETE=false
case "${1:-}" in
  --delete)        DELETE=true ;;
  ""|--dry-run)    DELETE=false ;;
  -h|--help)       sed -n '2,30p' "$0"; exit 0 ;;
  *) echo "Usage: $0 [--delete|--dry-run]" >&2; exit 2 ;;
esac

if $DELETE; then
  echo "MODE: DELETE — revisions WILL be removed.   project=$PROJECT region=$REGION"
else
  echo "MODE: DRY-RUN — nothing will be deleted.    project=$PROJECT region=$REGION"
fi
echo

# Cloud RUN services (not service accounts). Fail loudly if this can't be listed.
services=$(gcloud run services list --region="$REGION" --project="$PROJECT" \
  --format='value(metadata.name)') || {
  echo "ERROR: could not list Cloud Run services. Check: gcloud auth, project access, region." >&2
  exit 1
}

if [[ -z "${services// }" ]]; then
  echo "No Cloud Run services found in $PROJECT / $REGION. Nothing to do."
  exit 0
fi

would=0          # dry-run: revisions that WOULD be deleted
deleted=0        # --delete: revisions actually deleted
kept=0           # serving revisions kept
skipped_svc=0    # services skipped (no identifiable serving revision)
skipped_latest=0 # revisions skipped: Cloud Run won't delete the latest-created one
skipped_other=0  # revisions skipped: some other delete error

while IFS= read -r service; do
  [[ -z "$service" ]] && continue

  # Revision(s) currently receiving traffic — KEEP these. Tolerate describe failures.
  keep_raw=$(gcloud run services describe "$service" --region="$REGION" --project="$PROJECT" \
    --format='value(status.traffic[].revisionName)' 2>/dev/null) || keep_raw=""
  keep=$(printf '%s' "$keep_raw" | tr ';\n' '  ')

  # SAFETY GUARD: no identifiable serving revision → skip entirely, never delete-all.
  if [[ -z "${keep// }" ]]; then
    echo "⚠️  $service: no serving revision identified — SKIPPING (no deletes for this service)."
    skipped_svc=$((skipped_svc + 1))
    continue
  fi

  echo "── $service (keeping: $keep )"

  revisions=$(gcloud run revisions list --service="$service" --region="$REGION" --project="$PROJECT" \
    --format='value(metadata.name)' 2>/dev/null) || revisions=""
  [[ -z "${revisions// }" ]] && continue

  while IFS= read -r rev; do
    [[ -z "$rev" ]] && continue
    case " $keep " in
      *" $rev "*)
        kept=$((kept + 1))
        ;;
      *)
        if ! $DELETE; then
          echo "   WOULD delete $rev"
          would=$((would + 1))
        else
          # Run the delete inside an `if` so a failure does NOT abort the sweep
          # (set -e is suppressed for commands in an if-condition). Classify failures.
          if err=$(gcloud run revisions delete "$rev" --region="$REGION" --project="$PROJECT" --quiet 2>&1); then
            echo "   deleted      $rev"
            deleted=$((deleted + 1))
          elif printf '%s' "$err" | grep -qi "cannot be directly deleted\|latest created revision"; then
            # Cloud Run refuses to delete the latest-created revision directly
            # (e.g. a failed-deploy revision). It frees up after the next successful
            # deploy makes a new latest; a later sweep removes it then.
            echo "   skipped (latest-created, can't delete) $rev"
            skipped_latest=$((skipped_latest + 1))
          else
            reason=$(printf '%s' "$err" | tr '\n' ' ' | sed 's/  */ /g')
            echo "   skipped (delete failed) $rev — $reason"
            skipped_other=$((skipped_other + 1))
          fi
        fi
        ;;
    esac
  done <<< "$revisions"
done <<< "$services"

echo
if $DELETE; then
  echo "Done. Deleted $deleted revision(s); kept $kept serving."
  if (( skipped_latest > 0 )); then
    echo "Skipped $skipped_latest 'latest-created' revision(s): Cloud Run won't delete a service's"
    echo "  latest-created revision directly. These are freed by the NEXT successful deploy (it"
    echo "  creates a new latest), then a later run of this script sweeps them. Skipping now is fine."
  fi
  (( skipped_other > 0 )) && echo "Skipped $skipped_other revision(s) due to other delete errors (see above)."
  (( skipped_svc > 0 ))   && echo "Skipped $skipped_svc service(s) with no identifiable serving revision."
else
  echo "Dry-run complete. WOULD delete $would revision(s); would keep $kept serving; skipped $skipped_svc service(s)."
  echo "Re-run with --delete to apply. Latest-created revisions that Cloud Run refuses to delete"
  echo "are auto-skipped (reported in the summary), not fatal."
fi
