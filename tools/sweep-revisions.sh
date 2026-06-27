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

would=0   # deleted (or would-delete) count
kept=0    # serving revisions kept
skipped=0 # services skipped for safety

while IFS= read -r service; do
  [[ -z "$service" ]] && continue

  # Revision(s) currently receiving traffic — KEEP these. Tolerate describe failures.
  keep_raw=$(gcloud run services describe "$service" --region="$REGION" --project="$PROJECT" \
    --format='value(status.traffic[].revisionName)' 2>/dev/null) || keep_raw=""
  keep=$(printf '%s' "$keep_raw" | tr ';\n' '  ')

  # SAFETY GUARD: no identifiable serving revision → skip entirely, never delete-all.
  if [[ -z "${keep// }" ]]; then
    echo "⚠️  $service: no serving revision identified — SKIPPING (no deletes for this service)."
    skipped=$((skipped + 1))
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
        if $DELETE; then
          echo "   deleting     $rev"
          # gcloud also refuses to delete a revision serving traffic — backstop.
          gcloud run revisions delete "$rev" --region="$REGION" --project="$PROJECT" --quiet
        else
          echo "   WOULD delete $rev"
        fi
        would=$((would + 1))
        ;;
    esac
  done <<< "$revisions"
done <<< "$services"

echo
if $DELETE; then
  echo "Done. Deleted $would revision(s); kept $kept serving; skipped $skipped service(s)."
else
  echo "Dry-run complete. WOULD delete $would revision(s); would keep $kept serving; skipped $skipped service(s)."
  echo "Reviewed it? Re-run with --delete to apply."
fi
