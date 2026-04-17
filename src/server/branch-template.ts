type Ctx = Record<string, string>;

export function renderBranchTemplate(template: string, ctx: Ctx): string {
  const rendered = template.replace(/\{(\w+)\}/g, (_, key) => ctx[key] ?? '');
  return rendered
    .replace(/\/[_\-]+/g, '/')
    .replace(/[_\-]+$/g, '');
}
