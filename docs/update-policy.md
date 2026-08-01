# Continuous update policy

All We Need separates cheap discovery from expensive editorial work.

## Cadence

| Stage | Cadence | GPT usage |
| --- | ---: | --- |
| Source poll | Every 30 minutes | None |
| Fast lane | Immediately after discovery | Only when a material candidate exists |
| Standard events | At most every 2 hours | Batched |
| Explore | Every 6 hours | Batched |
| Conversations | Every 24 hours | Batched |

The two-hour value is a maximum wait, not a requirement to call a model every
two hours. An empty poll exits without analysis, build, commit, or deployment.

## Routing

- `fast`: material events from an authoritative publisher, official Fed or SEC
  records, and level-A discovery alerts that require immediate grounding.
- `standard`: product updates, changelogs, research releases, infrastructure,
  semiconductor, cloud, security, and macro developments.
- `explore`: commentary and thesis material that benefits from clustering
  rather than minute-level publication.
- `conversation`: long-form interviews, podcasts, and substantive video
  conversations.

The deterministic router only decides when a candidate is evaluated. It never
decides whether the candidate is published. The existing grounding, editorial
research, classification, quality bars, and old-article protection remain the
publication authority.

## Safety invariants

- Polling never advances the incremental cursor.
- A URL is processed only by a due lane.
- Fast-lane execution cannot consume queued Explore or Conversation items.
- Technical research failures remain deferred and retryable.
- No unseen candidates means no GPT call.
- No publishable changes means no build, commit, or deployment.

## Commands

- `npm run poll:feed`: fetch and create `tmp/feed-update-plan.json`.
- `npm run plan:feed`: recompute a plan from the current temporary snapshot.
- `npm run cycle:smart`: poll, execute only due lanes, and record their
  successful processing time.
- `npm run cycle:feed -- --lanes=fast --reuse-snapshot`: process only the fast
  lane from the snapshot produced by the current poll.
