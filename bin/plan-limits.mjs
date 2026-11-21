// The panel shows plan limits, usage and resets only. Meters about money the
// user could be charged (spend caps, overage, on-demand usage, top-ups,
// auto-reload, purchased balances) are dropped wherever they come from.
const NOT_A_PLAN_LIMIT = /spend|overage|on[- ]?demand|top[- ]?up|auto[- ]?reload|balance|purchas|extra usage|pay[- ]as[- ]you[- ]go|\bcredits? (bought|purchased)\b/i;
export const isPlanLimit = (limit) => !NOT_A_PLAN_LIMIT.test(String(limit?.title ?? "")) && !NOT_A_PLAN_LIMIT.test(String(limit?.detail ?? ""));
export const planLimitsOnly = (limits) => (Array.isArray(limits) ? limits.filter(isPlanLimit) : []);
