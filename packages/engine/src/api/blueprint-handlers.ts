import { BLUEPRINTS, blueprintDetail, blueprintSummary, findBlueprint } from "../blueprints";
import { createFromBlueprint } from "../blueprints/service";
import type { Handlers } from "./handlers";

/** Blueprints: tested starting points for new systems (list, look inside, start a project). */
export const blueprintHandlers: Pick<Handlers, "blueprints.list" | "blueprints.get" | "blueprints.create"> = {
  "blueprints.list": () => ({ blueprints: BLUEPRINTS.map(blueprintSummary) }),
  "blueprints.get": (p) => {
    const b = findBlueprint(p.id);
    if (!b) throw new Error(`There is no blueprint called "${p.id}".`);
    return blueprintDetail(b);
  },
  "blueprints.create": async (p, ctx) => {
    const res = await createFromBlueprint(p, { registry: ctx.registry, memory: ctx.memory });
    ctx.indexer.ensure(res.project.id);
    return res;
  },
};
