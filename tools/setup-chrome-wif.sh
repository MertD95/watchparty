#!/usr/bin/env bash
# One-time bootstrap in an authenticated Google Cloud Shell. This script creates
# no service-account keys, project roles, projects, or billing associations.
# Existing incompatible resources are refused, never repaired or overwritten.
# https://developer.chrome.com/docs/webstore/service-accounts
# https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines
set -euo pipefail

usage() {
  printf '%s\n' \
    'Usage: bash tools/setup-chrome-wif.sh --project PROJECT_ID --repository-id NUMBER --owner-id NUMBER' \
    'Run in an authenticated Google Cloud Shell with authority to enable APIs and manage this dedicated IAM setup.' \
    'The repository is fixed to MertD95/watchparty; use its immutable numeric repository and owner IDs.' \
    'This enables five APIs and creates/reuses one dedicated service account, pool, provider, and narrowly scoped binding.' \
    'No billing changes, virtual machines, or storage are created. API enablement may require billing on the existing project.' \
    'This is not a blanket guarantee of zero costs for your Google Cloud project.' \
    'An existing broader setup, disabled/deleted resource, or user-managed service-account key must be reviewed manually.' \
    'Afterward link the printed service-account email in Chrome Web Store Developer Dashboard > Account.'
}

fail() { printf 'Error: %s\n' "$1" >&2; exit 1; }
project_id='' repository_id='' owner_id=''
while (($#)); do
  case "$1" in
    --project|--repository-id|--owner-id)
      (($# >= 2)) || fail "Missing value for $1."
      case "$1" in
        --project) [[ -z "$project_id" ]] || fail 'Duplicate --project.'; project_id="$2" ;;
        --repository-id) [[ -z "$repository_id" ]] || fail 'Duplicate --repository-id.'; repository_id="$2" ;;
        --owner-id) [[ -z "$owner_id" ]] || fail 'Duplicate --owner-id.'; owner_id="$2" ;;
      esac
      shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail 'Unknown argument. Use --help.' ;;
  esac
done
[[ "$project_id" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || fail 'Provide a valid explicit Google Cloud project ID.'
[[ "$repository_id" =~ ^[1-9][0-9]{0,19}$ ]] || fail 'Provide a positive numeric repository ID.'
[[ "$owner_id" =~ ^[1-9][0-9]{0,19}$ ]] || fail 'Provide a positive numeric owner ID.'
command -v gcloud >/dev/null || fail 'gcloud is required; use Google Cloud Shell.'
command -v python3 >/dev/null || fail 'Python 3 is required; use Google Cloud Shell.'
# Never enable HTTP credential logging, even if the caller configured it globally.
export CLOUDSDK_CORE_LOG_HTTP=false
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

# All JSON comes from gcloud stdout. No dynamic code evaluation or files are used.
# Errors contain controlled labels only, not IAM policies, tokens, or API bodies.
json_check() {
  python3 -c '
import json, sys
mode, *args = sys.argv[1:]
def require(ok, label):
    if not ok:
        raise ValueError(label)
try:
    data = json.load(sys.stdin)
    if mode == "project":
        require(isinstance(data, dict) and data.get("projectId") == args[0] and data.get("lifecycleState") == "ACTIVE", "Project is not the requested active project.")
        number = str(data.get("projectNumber", ""))
        require(number.isascii() and number.isdigit() and int(number) > 0, "Invalid project number.")
        print(number)
    elif mode in ("accounts", "pools", "providers"):
        require(isinstance(data, list), "Invalid resource list.")
        key = "email" if mode == "accounts" else "name"
        matches = [item for item in data if isinstance(item, dict) and item.get(key) == args[0]]
        if mode == "providers":
            require(len(data) == len(matches), "Dedicated pool contains another provider; review its trust manually.")
        require(len(matches) <= 1, "Duplicate resource identity.")
        if not matches:
            print("absent")
        else:
            item = matches[0]
            require(item.get("disabled", False) is False, "Existing resource is disabled; it will not be re-enabled.")
            if mode != "accounts":
                require(item.get("state") == "ACTIVE", "Existing resource is not active; deleted resources will not be restored.")
            if mode == "providers":
                require(item.get("attributeCondition") == args[1], "Existing provider condition differs; no trust was overwritten.")
                require(item.get("attributeMapping") == {"google.subject": "assertion.sub", "attribute.repository_id": "assertion.repository_id"}, "Existing provider attribute mapping differs.")
                oidc = item.get("oidc", {})
                require(isinstance(oidc, dict) and oidc.get("issuerUri") == "https://token.actions.githubusercontent.com", "Existing provider has a different issuer.")
                require(not oidc.get("allowedAudiences") and not oidc.get("jwksJson") and "saml" not in item and "aws" not in item, "Existing provider has custom audience, keys, or protocol configuration.")
            print("present")
    elif mode == "keys":
        require(isinstance(data, list) and not data, "Dedicated service account has user-managed keys; review them manually.")
    elif mode == "project-policy":
        require(isinstance(data, dict), "Invalid project IAM policy.")
        require(all(args[0] not in binding.get("members", []) for binding in data.get("bindings", [])), "Dedicated service account already has a direct project role; review it manually.")
    elif mode == "account-policy":
        require(isinstance(data, dict), "Invalid service-account IAM policy.")
        bindings = data.get("bindings", [])
        require(isinstance(bindings, list), "Invalid service-account IAM bindings.")
        require(len(bindings) <= 1 and all(binding.get("role") == "roles/iam.workloadIdentityUser" and binding.get("members") == [args[0]] and not binding.get("condition") for binding in bindings), "Existing service-account trust differs; no permissions were overwritten.")
        print("present" if bindings else "absent")
    else:
        raise ValueError("Unknown validation mode.")
except (ValueError, TypeError, KeyError, AttributeError):
    # Only our own validation labels are printed; malformed provider JSON is generic.
    error = sys.exc_info()[1]
    label = str(error) if type(error) is ValueError else "Invalid Google Cloud resource data."
    if isinstance(error, json.JSONDecodeError):
        label = "Invalid Google Cloud JSON response."
    print("Error: " + label, file=sys.stderr)
    sys.exit(1)
' "$@"
}

project_number="$(gcloud projects describe "$project_id" --format=json --quiet | json_check project "$project_id")"
account_id='watchparty-cws-publisher'
account_email="${account_id}@${project_id}.iam.gserviceaccount.com"
pool_id='watchparty-github'
provider_id='github'
pool_name="projects/${project_number}/locations/global/workloadIdentityPools/${pool_id}"
provider_name="${pool_name}/providers/${provider_id}"
member="principalSet://iam.googleapis.com/${pool_name}/attribute.repository_id/${repository_id}"
condition="assertion.repository_id == '${repository_id}' && assertion.repository_owner_id == '${owner_id}' && assertion.sub == 'repo:MertD95/watchparty:environment:chrome-web-store' && assertion.workflow_ref == 'MertD95/watchparty/.github/workflows/release.yml@' + assertion.ref && ((assertion.event_name == 'release' && assertion.ref.startsWith('refs/tags/v')) || (assertion.event_name == 'workflow_dispatch' && assertion.ref == 'refs/heads/main'))"
mapping='google.subject=assertion.sub,attribute.repository_id=assertion.repository_id'

gcloud services enable chromewebstore.googleapis.com iam.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com cloudresourcemanager.googleapis.com \
  --project="$project_id" --quiet >/dev/null

# Discover without treating a permissions/API error as a missing resource.
account_state="$(gcloud iam service-accounts list --project="$project_id" --format=json --quiet | json_check accounts "$account_email")"
pool_state="$(gcloud iam workload-identity-pools list --project="$project_id" --location=global --show-deleted --format=json --quiet | json_check pools "$pool_name")"
provider_state='absent'
binding_state='absent'
if [[ "$pool_state" == 'present' ]]; then
  provider_state="$(gcloud iam workload-identity-pools providers list --project="$project_id" --location=global \
    --workload-identity-pool="$pool_id" --show-deleted --format=json --quiet | json_check providers "$provider_name" "$condition")"
fi
if [[ "$account_state" == 'present' ]]; then
  gcloud iam service-accounts keys list --iam-account="$account_email" --managed-by=user \
    --project="$project_id" --format=json --quiet | json_check keys
  binding_state="$(gcloud iam service-accounts get-iam-policy "$account_email" --project="$project_id" \
    --format=json --quiet | json_check account-policy "$member")"
fi
gcloud projects get-iam-policy "$project_id" --format=json --quiet | json_check project-policy "serviceAccount:${account_email}"

if [[ "$account_state" == 'absent' ]]; then
  gcloud iam service-accounts create "$account_id" --project="$project_id" \
    --display-name='WatchParty Chrome Web Store publisher' --quiet >/dev/null
fi
if [[ "$pool_state" == 'absent' ]]; then
  gcloud iam workload-identity-pools create "$pool_id" --project="$project_id" --location=global \
    --display-name='WatchParty GitHub publishing' --quiet >/dev/null
fi
if [[ "$provider_state" == 'absent' ]]; then
  gcloud iam workload-identity-pools providers create-oidc "$provider_id" --project="$project_id" \
    --location=global --workload-identity-pool="$pool_id" --issuer-uri='https://token.actions.githubusercontent.com' \
    --attribute-mapping="$mapping" --attribute-condition="$condition" --quiet >/dev/null
fi
if [[ "$binding_state" == 'absent' ]]; then
  gcloud iam service-accounts add-iam-policy-binding "$account_email" --project="$project_id" \
    --role=roles/iam.workloadIdentityUser --member="$member" --condition=None --quiet >/dev/null
fi

# Verify effective setup after writes too. If propagation is delayed, rerunning
# is safe; this script never silently broadens trust to make a retry succeed.
[[ "$(gcloud iam service-accounts list --project="$project_id" --format=json --quiet | json_check accounts "$account_email")" == 'present' ]] || fail 'Service account was not found after creation.'
[[ "$(gcloud iam workload-identity-pools list --project="$project_id" --location=global --show-deleted --format=json --quiet | json_check pools "$pool_name")" == 'present' ]] || fail 'Pool was not found after creation.'
[[ "$(gcloud iam workload-identity-pools providers list --project="$project_id" --location=global --workload-identity-pool="$pool_id" --show-deleted --format=json --quiet | json_check providers "$provider_name" "$condition")" == 'present' ]] || fail 'Provider was not found after creation.'
[[ "$(gcloud iam service-accounts get-iam-policy "$account_email" --project="$project_id" --format=json --quiet | json_check account-policy "$member")" == 'present' ]] || fail 'Service-account binding was not found after creation.'
gcloud iam service-accounts keys list --iam-account="$account_email" --managed-by=user --project="$project_id" --format=json --quiet | json_check keys
gcloud projects get-iam-policy "$project_id" --format=json --quiet | json_check project-policy "serviceAccount:${account_email}"

printf 'GOOGLE_PROJECT_NUMBER=%s\nGOOGLE_SERVICE_ACCOUNT=%s\nGOOGLE_WORKLOAD_IDENTITY_PROVIDER=%s\n' "$project_number" "$account_email" "$provider_name"
printf '%s\n' 'Next: link this service-account email in Chrome Web Store Developer Dashboard > Account, then configure the GitHub chrome-web-store environment. Google IAM changes may need five minutes to propagate.'
