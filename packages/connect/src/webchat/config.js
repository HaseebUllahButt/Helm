// What a web chat account carries in its environment. Kept free of other
// imports: the model list (models.js) and the driver read it.

export const ENGINE = 'webchat';

/** The settings a web chat account carries in its environment. */
export function webchatConfig(env = {}) {
  return {
    site: env.HELM_WEBCHAT_SITE || null,
    profile: env.HELM_WEBCHAT_PROFILE || null,
    model: env.HELM_WEBCHAT_MODEL || null,
    machine: env.HELM_WEBCHAT_MACHINE || null,
    temporary: env.HELM_WEBCHAT_TEMPORARY === '1',
  };
}

/** The model list for a web chat account: the one it names, if any (models.js). */
export function webchatModels(env = {}) {
  const { model } = webchatConfig(env);
  return { default: model, models: model ? [model] : [] };
}
