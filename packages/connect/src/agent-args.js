/** Flags consume their values; task words after -- are always literal. */
export function parseAgentArgs(args, { values = [], switches = [], repeat = [] } = {}) {
  const options = {}, words = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { words.push(...args.slice(i + 1)); break; }
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    const name = arg.slice(2);
    if (Object.hasOwn(options, name) && !repeat.includes(name)) throw new Error(`--${name} was given more than once`);
    if (switches.includes(name)) options[name] = true;
    else if (values.includes(name) || repeat.includes(name)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`);
      if (repeat.includes(name)) (options[name] ??= []).push(value);
      else options[name] = value;
    } else throw new Error(`unknown option: ${arg}`);
  }
  return { options, words };
}
