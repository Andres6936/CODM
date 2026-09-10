# CODM Daily Claim

Auto-claims the free DAILY GIFT (Legendary Secret Cache) from the official
Call of Duty: Mobile web store, every day, with no manual work.
Runs in GitHub Actions, so it works even when your PC or phone is off.

## What it does

The store gives every account one free "DAILY GIFT" per day. You can claim
it manually at store.callofdutymobile.com, but that means opening the site,
entering your Player ID and clicking CLAIM GIFT every single day.
This repo does exactly what the site's own button does, on a schedule, so
the gift is claimed automatically before you even wake up.

## How it works

The script `codm_claim.py` replicates the requests the official store makes in its browser, in the same order:

1. **Lookup** - sends your Player ID to the store's validation API, which returns your profile (nickname, short ID, rank) and your account's home country.
2. **Product** - fetches the store page for your country (for example `/in/codm` for India, `/iq/codm` for Iraq).
3. **Freebies** - asks for your available items and picks the daily gift.
4. **Token** - gets a short-lived claim token, same as the browser does when you click CLAIM GIFT.
5. **Claim** - posts the claim to the store's claim endpoint. One request, same as the button.

If the gift was already claimed that day, the script says so and exits quietly.
If the claim fails, it exits with an error so the workflow run shows up as failed in GitHub.

The account's home country is detected from the validation response, so a single
script handles every country the store supports. The claim endpoint is also taken
from the API response, so there is no hardcoded list of regions to maintain.

## Setup

1. Put this repo in your GitHub account (or fork it).
2. Open `.github/workflows/claim.yml`.
3. Replace the `USERNAME` value with your CODM Player ID/ CODM USERNAME.
4. Push. That's it.

The workflow runs daily at 06:30 UTC. You can also trigger it manually from the Actions tab.

## Output

Each run writes the full JSON response to `output/claim-YYYY-MM-DD.json`, committed to
the repo, so you can see what happened on any given day.

## Notes

- Only run this against your own account. A claim uses up that account's daily limit.
