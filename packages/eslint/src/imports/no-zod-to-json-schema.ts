import { importBanRule } from '../authoring/import-ban.ts';

export default importBanRule({
  description:
    'Disallow zod-to-json-schema, which reads Zod 3 internals and returns {} for a Zod 4 schema',
  packages: ['zod-to-json-schema'],
  message:
    'zod-to-json-schema reads the internals of Zod 3: given a Zod 4 schema it returns {} and throws nothing. Use z.toJSONSchema(schema) of zod 4.',
});
