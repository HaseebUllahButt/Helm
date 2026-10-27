// node --test reporter for test-smart: writes { "<file>": true } for each test
// file where every test passed and none was skipped or marked todo.
export default async function* passReporter(source) {
  const files = new Map();
  for await (const { type, data } of source) {
    if ((type !== 'test:pass' && type !== 'test:fail') || !data?.file) continue;
    const state = files.get(data.file) ?? { passed: 0, bad: false };
    if (type === 'test:fail' || data.skip || data.todo || data.skip === '' || data.todo === '') state.bad = true;
    else state.passed++;
    files.set(data.file, state);
  }
  yield JSON.stringify(Object.fromEntries([...files].map(([file, s]) => [file, !s.bad && s.passed > 0])));
}
