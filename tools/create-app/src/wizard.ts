import { basename, resolve } from 'node:path';
import {
  FEATURES,
  impliedBy,
  resolveFeatures,
  type Feature,
} from './features.js';
import { CancelledError, type PromptRunner } from './prompt.js';
import { ConfirmPrompt, SelectPrompt, TextPrompt } from './prompts.js';
import { blockingEntries, isValidPackageName } from './scaffold.js';
import type { Style } from './style.js';

/** Where to write, so the first question has an answer to accept. */
const DEFAULT_TARGET = 'my-api';

class DirectoryPrompt extends TextPrompt {
  protected override validate(value: string): string | undefined {
    return value.trim() === '' ? 'Name a directory to write into.' : undefined;
  }

  protected override hint(): string {
    return 'Enter to accept. A single "." writes into the directory you are in.';
  }
}

class PackageNamePrompt extends TextPrompt {
  protected override validate(value: string): string | undefined {
    return isValidPackageName(value)
      ? undefined
      : 'npm forbids uppercase, and a leading dot or underscore.';
  }
}

/**
 * The feature list, with the two things a flag could never show: which entries
 * the current selection pulls in behind your back, and which of them do nothing
 * without a service running.
 */
class FeaturePrompt extends SelectPrompt {
  constructor(style: Style, initial: readonly string[]) {
    super(
      style,
      'Features',
      FEATURES.map((feature) => ({
        value: feature.name,
        label: feature.name,
        hint: feature.summary,
      })),
      initial,
    );
  }

  #resolved(chosen: ReadonlySet<string>): readonly Feature[] {
    return resolveFeatures([...chosen]);
  }

  protected override implied(chosen: ReadonlySet<string>): ReadonlySet<string> {
    return new Set(impliedBy([...chosen], this.#resolved(chosen)));
  }

  protected override notes(chosen: ReadonlySet<string>): readonly string[] {
    const resolved = this.#resolved(chosen);
    const lines: string[] = [];

    const implied = impliedBy([...chosen], resolved);
    if (implied.length > 0) {
      const verb = implied.length === 1 ? 'comes' : 'come';
      lines.push(`${implied.join(', ')} ${verb} along as a requirement.`);
    }

    // Grouped by service rather than one line per feature: with jobs, cache and
    // throttle chosen, three lines all said Redis.
    const services = new Map<string, string[]>();
    for (const feature of resolved) {
      if (feature.service === undefined) continue;
      const named = services.get(feature.service) ?? [];
      named.push(feature.name);
      services.set(feature.service, named);
    }
    for (const [service, named] of services) {
      const verb = named.length === 1 ? 'needs' : 'need';
      lines.push(`${named.join(', ')} ${verb} ${service}.`);
    }
    return lines;
  }
}

export interface WizardAnswers {
  readonly target: string;
  readonly name: string;
  readonly features: readonly string[];
  readonly force: boolean;
}

/** What the flags already settled, so the wizard skips asking again. */
export interface WizardDefaults {
  readonly target: string | undefined;
  readonly name: string | undefined;
  readonly features: readonly string[];
  readonly force: boolean;
  readonly cwd: string;
}

/**
 * The questions, in the order the answers are needed.
 *
 * Each one is skipped when there is nothing to ask: a target given on the command
 * line, a package name that is already legal, a directory that is already empty.
 * Running `bunx @dunx/create-app my-api` in a clean directory therefore asks one
 * question, the one nothing else can answer.
 */
export class Wizard {
  readonly #runner: PromptRunner;
  readonly #style: Style;

  constructor(runner: PromptRunner, style: Style) {
    this.#runner = runner;
    this.#style = style;
  }

  async run(defaults: WizardDefaults): Promise<WizardAnswers> {
    const target =
      defaults.target ??
      (await this.#runner.ask(
        new DirectoryPrompt(this.#style, 'Directory', DEFAULT_TARGET),
      ));

    const name = await this.#name(defaults, target);
    const features = await this.#runner.ask(
      new FeaturePrompt(this.#style, defaults.features),
    );
    const force = await this.#force(defaults, target);

    return { target, name, features, force };
  }

  async #name(defaults: WizardDefaults, target: string): Promise<string> {
    if (defaults.name !== undefined) return defaults.name;
    const derived = basename(resolve(defaults.cwd, target));
    if (isValidPackageName(derived)) return derived;
    return this.#runner.ask(
      new PackageNamePrompt(this.#style, 'Package name', slug(derived)),
    );
  }

  async #force(defaults: WizardDefaults, target: string): Promise<boolean> {
    if (defaults.force) return true;
    const blocking = blockingEntries(resolve(defaults.cwd, target));
    if (blocking.length === 0) return false;

    const shown = blocking.slice(0, 3).join(', ');
    const rest = blocking.length > 3 ? `, +${blocking.length - 3} more` : '';
    const proceed = await this.#runner.ask(
      new ConfirmPrompt(
        this.#style,
        `${target} already has files in it (${shown}${rest}). Write into it anyway?`,
        false,
      ),
    );
    if (!proceed) throw new CancelledError('Nothing written.');
    return true;
  }
}

/**
 * A package name npm will take, from a directory name it will not. Uppercase and
 * the characters npm forbids both become a hyphen, and a leading dot, underscore
 * or hyphen is dropped.
 */
export const slug = (value: string): string => {
  const lowered = value
    .toLowerCase()
    .replace(/[^a-z0-9\-._~]+/g, '-')
    .replace(/^[-._]+/, '')
    .replace(/-+$/, '');
  return lowered === '' ? DEFAULT_TARGET : lowered;
};
