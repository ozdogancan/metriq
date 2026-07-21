// Private fixtures stay outside Git. Every slot can be supplied through its
// generic environment variables. The replay runner can also discover the
// numbered slots from METRIQ_CORPUS_ROOT without committing private paths.

export const METRIQ_CORPUS_MANIFEST_VERSION = 2;

function privateFixture(index, expectation = 'scored', propsDiscoveryIndex = null) {
  const slot = String(index).padStart(2, '0');
  return {
    id: `fixture-${slot}`,
    label: `Private fixture ${slot}`,
    expectation,
    discoveryIndex: index - 1,
    ...(propsDiscoveryIndex == null ? {} : { propsDiscoveryIndex }),
    external: {
      nwdEnv: `METRIQ_CORPUS_FIXTURE_${slot}_NWD`,
      answerEnv: `METRIQ_CORPUS_FIXTURE_${slot}_ANSWER`,
      propsEnv: `METRIQ_CORPUS_FIXTURE_${slot}_PROPS`,
    },
  };
}

export const metriqCorpusManifest = Object.freeze([
  {
    id: 'golden-optional',
    label: 'Optional local golden',
    optional: true,
    expectation: 'scored',
    external: {
      nwdEnv: 'METRIQ_CORPUS_GOLDEN_NWD',
      answerEnv: 'METRIQ_CORPUS_GOLDEN_ANSWER',
    },
  },
  privateFixture(1, 'scored', 0),
  privateFixture(2, 'scored', 1),
  privateFixture(3, 'scored', 2),
  privateFixture(4, 'scored', 3),
  privateFixture(5),
  privateFixture(6),
  privateFixture(7, 'scored', 4),
  {
    ...privateFixture(8, 'unsupported', 5),
    unsupportedReason: 'The control model has no structured MTO properties; fail closed instead of inventing quantities.',
  },
]);
