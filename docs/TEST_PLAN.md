# Test Expansion Plan

Target: move from a handful of broad end-to-end tests to a layered test suite.

## Unit tests
- estimator rules per trade
- rounding / cents integrity
- matching score
- compliance hard guardrail
- margin calculations
- lead scoring
- contractor lifecycle
- AI recommendation rules

## Authorization tests
For each entity:
- anonymous
- wrong customer
- correct customer
- wrong contractor
- assigned contractor
- admin

Entities:
- jobs
- photos/media
- estimates
- quotes
- projects
- milestones
- messages
- payments
- contractor records
- payouts

## Stripe integration tests
- duplicate webhook
- payment succeeded
- payment failed
- refund
- partial refund
- duplicate intent request
- invalid signature
- mismatched amount
- project ownership enforcement

## Load/concurrency
- 100 simultaneous job submissions
- photo upload burst
- concurrent quote acceptance
- concurrent PaymentIntent creation
- concurrent contractor offer acceptance

## Goal
Initial launch gate: 100+ automated tests with all P0 flows covered.
