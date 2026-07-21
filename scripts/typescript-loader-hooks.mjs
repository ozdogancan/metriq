// Raw-Node corpus tooling only: mirror Next's relative extensionless .ts
// resolution without altering package imports or accepting arbitrary schemes.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') {
    return { url: 'data:text/javascript,export{}', shortCircuit: true };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND'
      && /^\.\.?\//.test(specifier)
      && !/\.[a-z0-9]+$/i.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
}

