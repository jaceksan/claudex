type Ctx = Record<string, string>;

export function renderBranchTemplate(template: string, ctx: Ctx): string {
  const rendered = template.replace(/\{(\w+)\}/g, (_, key) => ctx[key] ?? '');
  return rendered
    .replace(/\/{2,}/g, '/')
    .replace(/\/[_\-]+/g, '/')
    // When a placeholder is empty the separator on both sides collapses into a run of
    // 3+ underscores (e.g. "__{ticket}__" with ticket='' becomes '____'). Normalise
    // back to the '__' separator width so the result is still a clean branch name.
    .replace(/_{3,}/g, '__')
    .replace(/[_\-]+$/g, '');
}
