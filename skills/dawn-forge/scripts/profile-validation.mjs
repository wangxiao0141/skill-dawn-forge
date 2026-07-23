const allowedTopLevel = new Set([
  "schemaVersion",
  "id",
  "name",
  "platform",
  "software",
  "settings",
  "manualTasks",
]);
const allowedSoftware = new Set([
  "id",
  "name",
  "source",
  "package",
  "version",
  "required",
]);
const allowedSettings = new Set(["git", "ssh"]);
const allowedGit = new Set(["userName", "userEmail", "defaultBranch"]);
const allowedSsh = new Set(["githubKey", "generalKey"]);
const allowedPlatforms = new Set(["macos", "windows"]);
const allowedSources = new Set([
  "auto",
  "brew-formula",
  "brew-cask",
  "mac-app-store",
  "winget",
  "microsoft-store",
  "npm-global",
  "volta-tool",
  "official-download",
  "manual",
]);
const macosOnlySources = new Set([
  "brew-formula",
  "brew-cask",
  "mac-app-store",
]);
const windowsOnlySources = new Set(["winget", "microsoft-store"]);
const packageRequiredSources = new Set([
  ...macosOnlySources,
  ...windowsOnlySources,
  "npm-global",
  "volta-tool",
]);
const secretKeyPattern =
  /(?:password|passwd|token|secret|credential|subscription|private.?key|api.?key)/i;
const privateKeyPattern = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const credentialUrlPattern =
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;
const urlPattern = /\b[a-z][a-z0-9+.-]*:\/\/|(?:^|\s)www\./i;
const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/u;
const commandInterpolationPattern =
  /(?:`|\$\(|\$\{|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%)/;
const shellOperatorPattern = /(?:&&|\|\||[;&|]|<{1,2}|>{1,2})/;
const obviousCommandPattern =
  /^\s*(?:(?:PS(?:\s+[^>]*)?>|\$|>)\s*)?(?:sudo\s+)?(?:bash|brew|chmod|chown|cmd(?:\.exe)?|cp|curl|git|mkdir|mv|node|npm|npx|open|pnpm|powershell|pwsh|python(?:3)?|rm|scp|sh|ssh|start-process|winget|wget|yarn|zsh)(?:\s|$)/i;
const safePackagePattern = /^[A-Za-z0-9@+._/:-]+$/;
const safeVersionPattern = /^[A-Za-z0-9][A-Za-z0-9.+_~^-]*$/;

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function validateProfile(profile) {
  const errors = [];

  function rejectUnknownKeys(value, allowed, path) {
    if (!isPlainObject(value)) return;
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) errors.push(`${path}: contains an unknown field`);
    }
  }

  function scanForSecrets(value, path = "$") {
    if (Array.isArray(value)) {
      value.forEach((item, index) => scanForSecrets(item, `${path}[${index}]`));
      return;
    }
    if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (secretKeyPattern.test(key)) {
          errors.push(`${path}: secret-like fields are forbidden`);
        }
        // Object keys are untrusted too. Keep only the nearest safe parent path
        // so a key containing a token or URL cannot be reflected in an error.
        scanForSecrets(child, path);
      }
      return;
    }
    if (typeof value === "string") {
      if (privateKeyPattern.test(value)) {
        errors.push(`${path}: private key content is forbidden`);
      }
      if (credentialUrlPattern.test(value)) {
        errors.push(`${path}: URLs with embedded credentials are forbidden`);
      }
    }
  }

  function requireNonEmptyString(value, path, maxLength = 200) {
    if (typeof value !== "string" || value.trim().length === 0) {
      errors.push(`${path}: must be a non-empty string`);
      return false;
    }
    if (value.length > maxLength) {
      errors.push(`${path}: must be at most ${maxLength} characters`);
      return false;
    }
    if (controlCharacterPattern.test(value)) {
      errors.push(`${path}: control characters are forbidden`);
      return false;
    }
    return true;
  }

  function rejectUnsafeCommonString(value, path) {
    let safe = true;
    if (controlCharacterPattern.test(value)) {
      errors.push(`${path}: control characters are forbidden`);
      safe = false;
    }
    if (urlPattern.test(value)) {
      errors.push(`${path}: URLs are forbidden`);
      safe = false;
    }
    if (commandInterpolationPattern.test(value)) {
      errors.push(`${path}: command interpolation is forbidden`);
      safe = false;
    }
    if (shellOperatorPattern.test(value)) {
      errors.push(`${path}: shell operators are forbidden`);
      safe = false;
    }
    return safe;
  }

  function validatePackage(value, path) {
    if (!requireNonEmptyString(value, path, 160)) return;

    rejectUnsafeCommonString(value, path);
    const normalized = value.trim();

    if (normalized !== value) {
      errors.push(`${path}: surrounding whitespace is forbidden`);
    }
    if (/\s/u.test(value)) {
      errors.push(`${path}: whitespace is forbidden`);
    }
    if (normalized.startsWith("-")) {
      errors.push(`${path}: leading options are forbidden`);
    }
    if (value.includes("\\")) {
      errors.push(`${path}: backslashes are forbidden`);
    }
    if (/^(?:\/|[A-Za-z]:)/.test(normalized)) {
      errors.push(`${path}: absolute paths are forbidden`);
    }

    const pathSegments = normalized.split("/");
    if (
      pathSegments.some(
        (segment) => segment.length === 0 || segment === "." || segment === "..",
      )
    ) {
      errors.push(`${path}: empty or traversal path segments are forbidden`);
    }
    if (!safePackagePattern.test(value)) {
      errors.push(`${path}: contains unsupported identifier characters`);
    }
  }

  function validateVersion(value, path) {
    if (!requireNonEmptyString(value, path, 80)) return;

    rejectUnsafeCommonString(value, path);
    const normalized = value.trim();

    if (normalized !== value) {
      errors.push(`${path}: surrounding whitespace is forbidden`);
    }
    if (/\s/u.test(value)) {
      errors.push(`${path}: whitespace is forbidden`);
    }
    if (normalized.startsWith("-")) {
      errors.push(`${path}: leading options are forbidden`);
    }
    if (/[\\/]/.test(value) || value === "." || value === "..") {
      errors.push(`${path}: paths and traversal are forbidden`);
    }
    if (!safeVersionPattern.test(value)) {
      errors.push(`${path}: contains unsupported version characters`);
    }
  }

  if (!isPlainObject(profile)) {
    return ["$: profile must be a JSON object"];
  }

  rejectUnknownKeys(profile, allowedTopLevel, "$");
  scanForSecrets(profile);

  if (profile.schemaVersion !== 1) {
    errors.push("$.schemaVersion: only schemaVersion 1 is supported");
  }

  if (
    requireNonEmptyString(profile.id, "$.id", 63) &&
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(profile.id)
  ) {
    errors.push("$.id: use lowercase letters, digits, and internal hyphens");
  }

  requireNonEmptyString(profile.name, "$.name", 100);

  if (!allowedPlatforms.has(profile.platform)) {
    errors.push("$.platform: must be 'macos' or 'windows'");
  }

  if (!Array.isArray(profile.software)) {
    errors.push("$.software: must be an array");
  } else {
    const ids = new Set();
    const names = new Set();

    profile.software.forEach((item, index) => {
      const path = `$.software[${index}]`;
      if (!isPlainObject(item)) {
        errors.push(`${path}: must be an object`);
        return;
      }

      rejectUnknownKeys(item, allowedSoftware, path);

      if (
        requireNonEmptyString(item.id, `${path}.id`, 63) &&
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(item.id)
      ) {
        errors.push(
          `${path}.id: use lowercase letters, digits, and internal hyphens`,
        );
      }
      if (typeof item.id === "string") {
        const normalizedId = item.id.trim().toLowerCase();
        if (ids.has(normalizedId)) errors.push(`${path}.id: duplicate software id`);
        ids.add(normalizedId);
      }

      if (requireNonEmptyString(item.name, `${path}.name`, 100)) {
        const normalizedName = item.name.trim().toLowerCase();
        if (names.has(normalizedName)) {
          errors.push(`${path}.name: duplicate software name`);
        }
        names.add(normalizedName);
      }

      const source = item.source ?? "auto";
      if (!allowedSources.has(source)) {
        errors.push(`${path}.source: unsupported source`);
      }
      if (profile.platform === "macos" && windowsOnlySources.has(source)) {
        errors.push(`${path}.source: source is incompatible with macos`);
      }
      if (profile.platform === "windows" && macosOnlySources.has(source)) {
        errors.push(`${path}.source: source is incompatible with windows`);
      }

      if (item.package !== undefined) {
        validatePackage(item.package, `${path}.package`);
        if (
          typeof item.package === "string" &&
          item.package.trim().length > 0
        ) {
          if (
            macosOnlySources.has(source) &&
            !/^[A-Za-z0-9@+._/-]+$/.test(item.package)
          ) {
            errors.push(`${path}.package: invalid macOS package identifier`);
          }
          if (
            windowsOnlySources.has(source) &&
            !/^[A-Za-z0-9._-]+$/.test(item.package)
          ) {
            errors.push(`${path}.package: invalid Windows package identifier`);
          }
          if (
            source === "npm-global" &&
            !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(
              item.package,
            )
          ) {
            errors.push(`${path}.package: invalid npm package identifier`);
          }
          if (
            source === "volta-tool" &&
            !/^[a-z0-9][a-z0-9._-]*$/.test(item.package)
          ) {
            errors.push(`${path}.package: invalid Volta tool identifier`);
          }
        }
      } else if (packageRequiredSources.has(source)) {
        errors.push(`${path}.package: required for selected source`);
      }

      if (item.version !== undefined) {
        validateVersion(item.version, `${path}.version`);
      }
      if (item.required !== undefined && typeof item.required !== "boolean") {
        errors.push(`${path}.required: must be a boolean`);
      }
    });
  }

  if (profile.settings !== undefined) {
    if (!isPlainObject(profile.settings)) {
      errors.push("$.settings: must be an object");
    } else {
      rejectUnknownKeys(profile.settings, allowedSettings, "$.settings");

      if (profile.settings.git !== undefined) {
        if (!isPlainObject(profile.settings.git)) {
          errors.push("$.settings.git: must be an object");
        } else {
          rejectUnknownKeys(profile.settings.git, allowedGit, "$.settings.git");
          for (const key of ["userName", "userEmail", "defaultBranch"]) {
            if (profile.settings.git[key] !== undefined) {
              requireNonEmptyString(
                profile.settings.git[key],
                `$.settings.git.${key}`,
                200,
              );
            }
          }
          if (
            profile.settings.git.defaultBranch !== undefined &&
            !/^[A-Za-z0-9._/-]+$/.test(profile.settings.git.defaultBranch)
          ) {
            errors.push(
              "$.settings.git.defaultBranch: contains unsupported characters",
            );
          }
        }
      }

      if (profile.settings.ssh !== undefined) {
        if (!isPlainObject(profile.settings.ssh)) {
          errors.push("$.settings.ssh: must be an object");
        } else {
          rejectUnknownKeys(profile.settings.ssh, allowedSsh, "$.settings.ssh");
          for (const key of allowedSsh) {
            if (
              profile.settings.ssh[key] !== undefined &&
              typeof profile.settings.ssh[key] !== "boolean"
            ) {
              errors.push(`$.settings.ssh.${key}: must be a boolean`);
            }
          }
        }
      }
    }
  }

  if (profile.manualTasks !== undefined) {
    if (!Array.isArray(profile.manualTasks)) {
      errors.push("$.manualTasks: must be an array");
    } else {
      profile.manualTasks.forEach((task, index) => {
        const path = `$.manualTasks[${index}]`;
        if (!requireNonEmptyString(task, path, 300)) return;
        rejectUnsafeCommonString(task, path);
        if (obviousCommandPattern.test(task)) {
          errors.push(
            `${path}: command-like content is forbidden; manual tasks are display-only`,
          );
        }
      });
    }
  }

  return errors;
}
