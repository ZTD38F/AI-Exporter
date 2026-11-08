---
title: Gemini Exporter Stats Privacy Policy
permalink: /stats-privacy/
---

# Gemini Exporter Stats Privacy Policy

**Last updated: October 2026**

Gemini Exporter Stats is a maintainer-only automation used to retrieve aggregate analytics for the Gemini Exporter Chrome Web Store listing.

This automation is separate from the Gemini Exporter browser extension. Installing or using Gemini Exporter does not require Google OAuth authorization for this automation.

## Data Access

Gemini Exporter Stats requests read-only access to Google Analytics using the following OAuth scope:

`https://www.googleapis.com/auth/analytics.readonly`

The automation uses this access only to retrieve aggregate statistics associated with the Gemini Exporter Chrome Web Store listing, such as installation event counts.

## How Data Is Used

Aggregate installation statistics may be stored in the public Gemini Exporter GitHub repository and used to generate public project growth statistics, including charts displayed in the project README or website.

Gemini Exporter Stats does not:

- modify Google Analytics data;
- access Gemini Exporter users' Google accounts;
- access individual Chrome extension users' identities;
- publish individual-level Analytics data;
- use Analytics data for advertising or user profiling;
- sell Analytics data;
- share Analytics data with third parties for commercial purposes.

## OAuth Credentials

OAuth credentials used by the automation are private maintainer credentials.

They are not published in the Gemini Exporter repository and are used only to authorize automated read-only Analytics requests.

## Gemini Exporter Extension

This policy applies only to the maintainer-side Gemini Exporter Stats automation.

For information about how the Gemini Exporter browser extension handles user data, see the [Gemini Exporter Privacy Policy](./PRIVACY_POLICY.html).

## Contact

Questions about this policy can be submitted through the Gemini Exporter GitHub repository:

<https://github.com/OTLFrostA/gemini-exporter/issues>
