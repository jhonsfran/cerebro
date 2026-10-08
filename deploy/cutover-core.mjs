// The command leaves execution stopped. Enabling a reviewed Pi release is a separate operator action.
export const prepareCutover = async (operations) => {
  const prior = await operations.readFence();
  await operations.stopExecution();
  await operations.assertExecutionStopped();
  if (prior?.phase === "retired") {
    await operations.verifyRetirement(prior);
    return prior;
  }
  const fence = await operations.commitFence();
  const unresolved = await operations.snapshotUnresolved();
  await operations.saveSnapshot(unresolved, fence);
  await operations.snapshotStores();
  await operations.assertExecutionStopped();
  const retired = await operations.retireAndQuarantine(fence);
  await operations.saveRetirement(retired);
  return retired;
};

export const restoreRetirementFence = async (operations, retirement) => {
  if (retirement?.phase !== "retired" || retirement.engine !== "pi-v1") {
    throw new Error("A completed Pi retirement record is required.");
  }
  await operations.assertExecutionStopped();
  await operations.retireAndQuarantine(retirement);
  await operations.assertExecutionStopped();
};
