export function getSnapshotPath(basePath: string) {
  return `${basePath}.snapshot`;
}

export function getSnapshotTmpPath(basePath: string) {
  return `${getSnapshotPath(basePath)}.tmp`;
}

export function getDeltaPath(basePath: string) {
  return `${basePath}.delta`;
}

export function getCacheArtifactPaths(basePath: string) {
  const snapshotPath = getSnapshotPath(basePath);
  const deltaPath = getDeltaPath(basePath);
  return {
    legacyPath: basePath,
    legacyTmpPath: `${basePath}.tmp`,
    snapshotPath,
    snapshotTmpPath: `${snapshotPath}.tmp`,
    deltaPath,
  };
}
