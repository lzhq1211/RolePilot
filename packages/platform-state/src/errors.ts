export class PlatformStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class CheckpointNotFoundError extends PlatformStateError {}

export class StaleCheckpointError extends PlatformStateError {}

export class PlanFingerprintMismatchError extends PlatformStateError {}

export class UnsupportedCheckpointSchemaError extends PlatformStateError {}

export class CheckpointTargetMismatchError extends PlatformStateError {}
