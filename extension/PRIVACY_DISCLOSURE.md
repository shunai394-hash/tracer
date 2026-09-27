# TRACER Product Capture — Privacy Disclosure

## Data handled

The extension handles product data from a supported Amazon product page:

- page URL
- ASIN, when available
- product title
- brand, when available
- displayed price, when available
- primary product image URL, when available
- capture timestamp

The extension stores only its TRACER API base URL and optional ingestion credential in Chrome local storage.

## Purpose

The data is sent to the user's configured TRACER endpoint to support product identification, normalization, price observation, supplier research, and related commerce intelligence.

## Data not collected

The extension does not intentionally collect:

- browsing history
- passwords
- authentication cookies
- bookmarks
- payment card data
- precise location
- contacts

## Transfers

Captured product information is transmitted to the configured TRACER server. TRACER may pass product information to EC-Pulse for server-side normalization and intelligence processing.

## Security

Backend API keys and database service-role credentials must remain server-side. They are not distributed with the extension.

## User control

The user initiates capture by clicking the extension action. The user can remove the extension or clear its local storage at any time.

## Policy note

The Chrome Web Store Developer Dashboard must be completed with the deployed privacy-policy URL and the final data-use declarations before submission.
