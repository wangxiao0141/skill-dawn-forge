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
]);
const secretKeyPattern =
  /(?:password|passwd|token|secret|credential|subscription|private.?key|api.?key)/i;
const privateKeyPattern = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const credentialUrlPattern =
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;

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
      if (!allowed.has(key)) errors.push(`${path}.${key}: unknown field`);
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
          errors.push(`${path}.${key}: secret-like fields are forbidden`);
        }
        scanForSecrets(child, `${path}.${key}`);
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
    return true;
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
        errors.push(`${path}.source: unsupported source '${source}'`);
      }
      if (profile.platform === "macos" && windowsOnlySources.has(source)) {
        errors.push(`${path}.source: '${source}' is incompatible with macos`);
      }
      if (profile.platform === "windows" && macosOnlySources.has(source)) {
        errors.push(`${path}.source: '${source}' is incompatible with windows`);
      }

      if (item.package !== undefined) {
        if (requireNonEmptyString(item.package, `${path}.package`, 160)) {
          if (/^[a-z][a-z0-9+.-]*:\/\//i.test(item.package)) {
            errors.push(`${path}.package: URLs are forbidden`);
          }
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
        }
      } else if (packageRequiredSources.has(source)) {
        errors.push(`${path}.package: required for source '${source}'`);
      }

      if (item.version !== undefined) {
        requireNonEmptyString(item.version, `${path}.version`, 80);
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
        requireNonEmptyString(task, `$.manualTasks[${index}]`, 300);
      });
    }
  }

  return errors;
}
