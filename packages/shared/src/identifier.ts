// Kept apart from ids.ts, and free of dependencies, so code that ships to
// browsers and App bundles (the SDK's reader) can use it without Zod.

/**
 * The longest an ID, or any other identifier, may be: room for provider IDs
 * (Microsoft Graph item IDs run past 100 characters), not for content.
 * Everything that names something has to fit in an audit event, which names
 * things and never carries their content.
 */
export const identifierMaxLength = 256;
