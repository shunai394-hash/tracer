import type { OpportunityLifecycleStatus, SellabilityState } from "@/lib/domain/types";

export function deriveLifecycleStatus(args: {
  existingLifecycle?: string | null;
  sellabilityState: SellabilityState;
  hasActiveTest: boolean;
  hasObservedResults: boolean;
  hasFailureLearning: boolean;
}): OpportunityLifecycleStatus {
  if (
    args.existingLifecycle === "PAUSED" ||
    args.existingLifecycle === "ARCHIVED"
  ) {
    return args.existingLifecycle;
  }

  if (args.sellabilityState === "REJECTED") {
    return "REJECTED";
  }

  if (args.hasFailureLearning) {
    return "LEARNING";
  }

  if (args.hasObservedResults) {
    return "MEASURED";
  }

  if (args.hasActiveTest) {
    return "TESTING";
  }

  if (args.sellabilityState === "TEST_READY") {
    return "TEST_READY";
  }

  if (
    args.sellabilityState === "WATCH" ||
    args.sellabilityState === "SELLABLE" ||
    args.sellabilityState === "NEEDS_DATA"
  ) {
    return "VALIDATING";
  }

  return "DISCOVERED";
}
