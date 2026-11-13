import { myEntity } from "../state/store";
import { REACH, cheb, reachState, targetsOnMap, targetTitle, verbsFor, type Target, type VerbOption } from "../util/interact";
import type { MenuItem } from "./menu";
import type { Ctx } from "./types";

/** Menu lines for one target: only the verbs that fit its kind and state, disabled with a reason when out of reach. */
export function targetMenu(ctx: Ctx, t: Target): MenuItem[] {
  const me = myEntity(ctx.store.state);
  return verbsFor(t).map((opt) => {
    const st = reachState(opt, me, t);
    return { label: opt.label, ...(st.hint ? { hint: st.hint } : {}), disabled: st.disabled, run: () => sendVerb(ctx, opt) };
  });
}

export function sendVerb(ctx: Ctx, opt: VerbOption): void {
  if (opt.send === "container") ctx.client.send("container_action", { verb: "open", container_id: opt.target_id });
  else ctx.client.send("act", { verb: opt.verb, target_id: opt.target_id });
}

/** Things within reach of me (the keyboard route to the map menu), nearest first, each with its verbs. */
export function nearbyMenu(ctx: Ctx): MenuItem[] {
  const s = ctx.store.state;
  const me = myEntity(s);
  if (!me) return [];
  return targetsOnMap(s.map, s.containers, Object.values(s.entities))
    .map((t) => ({ t, d: cheb(me, t) }))
    .filter((x) => x.d <= REACH)
    .sort((a, b) => a.d - b.d)
    .map(({ t }) => ({ label: targetTitle(t, s.entities), children: targetMenu(ctx, t) }));
}
