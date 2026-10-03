# TRACER Customer Quality Bar

TRACER is judged from the customer's point of view first. Technical completeness is necessary, but it is not the definition of quality.

## Core question

> Why would a person choose TRACER instead of searching a marketplace, social network, or Google?

The product must create a concrete gain:
- Discovery gain: find products the customer would not have searched for.
- Time gain: let AI continuously scan markets instead of requiring manual research.
- Information gain: explain why an item is attracting attention using confirmed evidence.
- Decision gain: separate confirmed facts from unknowns so the customer can decide with less uncertainty.
- Return gain: every visit should have a credible reason to discover something new.

## Human experience loop

Why open → curiosity → discovery → I didn't know this → understanding → trust → value → action → result → return

Every major screen must answer:
1. What can I get here?
2. Why is this useful to me?
3. What should I do next?
4. What makes this different from a normal marketplace?
5. What evidence can I trust?
6. What reason do I have to come back?

## Product loop

World → AI patrol → discovery → identity verification → supply verification → economics → test → result → learning → next discovery

AI is the enabling layer, not the hero. Internal pipeline complexity should stay invisible unless it helps the customer make a decision.

## Release checklist

Code → CI → production SHA → production smoke → E2E → data integrity → AI loop → UX review → same scenario rerun → diff check → repair → repeat

### Customer
- 5-second first impression communicates the value.
- Primary CTA is obvious.
- Navigation is understandable without explanation.
- Product cards make curiosity and next action clear.
- Product detail builds trust without dumping internal system terminology.
- Cart and checkout are simple and reassuring.
- Mobile interaction is comfortable.
- Accessibility states and keyboard focus are usable.
- Empty/error states still provide a useful next action.

### Content and visual craft
- Strong point of view.
- Clear hierarchy and rhythm.
- Product imagery is high quality and consistent.
- Motion supports comprehension rather than decoration.
- No unnecessary technical jargon.
- No unsupported hype, fake scarcity, or invented popularity.

### Data and AI
- Identity is not inferred from title alone.
- Unknown values remain unknown.
- Unverified costs are never treated as zero.
- Demand signals are distinguished from confirmed sales evidence.
- Supply discovery cannot bypass market/identity quality gates.
- AI patrol produces useful new discoveries, not repetitive filler.
- AI results are explainable enough for customer trust.
- Failed candidates feed back into the next patrol/selection cycle.

### System
- No weakening of publication gates to make the catalog look full.
- No fake products for visual completeness.
- No secret values exposed.
- Production errors are investigated, not hidden.
- Same scenario is rerun after every repair.

## Quality target

Use the current Webby criteria as an external benchmark:
- Content
- Structure & Navigation
- Visual Design
- Functionality
- Interactivity
- Innovation
- Overall Experience

The target is not to claim an award. The target is to build work that can withstand that level of scrutiny.

For AI, the additional standard is: enhance the experience, solve a real problem, and preserve trust and integrity.

## Stop condition

Do not stop at looks better.

Stop only after:
- the customer value is clearer,
- the next action is easier,
- the product quality is higher,
- the data/AI precision is higher,
- the same scenario passes again,
- production behavior is verified,
- and the remaining weakness is explicitly known.