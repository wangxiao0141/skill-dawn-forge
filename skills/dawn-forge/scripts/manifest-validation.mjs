const allowedTopLevel = new Set([
  "schemaVersion",
  "target",
  "software",
  "settings",
  "manualTasks",
]);
const allowedTarget = new Set(["id", "host", "user"]);
const allowedSoftware = new Set([
  "name",
  "source",
  "package",
  "version",
  "required",
]);
const allowedSettings = new Set(["git"]);
const allowedGit = new Set(["userName", "userEmail", "defaultBranch"]);
const allowedSources = new Set([
  "auto",
  "brew-formula",
  "brew-cask",
  "app-store",
  "official-download",
  "manual",
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

function isValidHostname(value) {
  if (
    typeof value !== "string" ||
    value.length > 253 ||
    !value.includes(".")
  ) {
    return false;
  }

  return value.split(".").every((label) =>
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
  );
}

export function validateManifest(manifest) {
  const errors = [];

  function rejectUnknownKeys(value, allowed, path) {
    if (!isPlainObject(value)) return;
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        errors.push(`${path}.${key}: unknown field`);
      }
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

  if (!isPlainObject(manifest)) {
    return ["$: manifest must be a JSON object"];
  }

  rejectUnknownKeys(manifest, allowedTopLevel, "$");
  scanForSecrets(manifest);

  if (manifest.schemaVersion !== 1) {
    errors.push("$.schemaVersion: only schemaVersion 1 is supported");
  }

  if (!isPlainObject(manifest.target)) {
    errors.push("$.target: must be an object");
  } else {
    rejectUnknownKeys(manifest.target, allowedTarget, "$.target");

    if (
      requireNonEmptyString(manifest.target.id, "$.target.id", 63) &&
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(manifest.target.id)
    ) {
      errors.push(
        "$.target.id: use lowercase letters, digits, and internal hyphens",
      );
    }

    if (
      requireNonEmptyString(manifest.target.host, "$.target.host", 253) &&
      !isValidHostname(manifest.target.host)
    ) {
      errors.push(
        "$.target.host: must be a DNS name without user, port, URL, or shell characters",
      );
    }

    if (
      requireNonEmptyString(manifest.target.user, "$.target.user", 64) &&
      !/^[A-Za-z_][A-Za-z0-9._-]{0,63}$/.test(manifest.target.user)
    ) {
      errors.push("$.target.user: must be a valid macOS short username");
    }
  }

  if (!Array.isArray(manifest.software)) {
    errors.push("$.software: must be an array");
  } else {
    const names = new Set();

    manifest.software.forEach((item, index) => {
      const path = `$.software[${index}]`;
      if (!isPlainObject(item)) {
        errors.push(`${path}: must be an object`);
        return;
      }

      rejectUnknownKeys(item, allowedSoftware, path);

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

      if (item.package !== undefined) {
        if (requireNonEmptyString(item.package, `${path}.package`, 160)) {
          if (/^[a-z][a-z0-9+.-]*:\/\//i.test(item.package)) {
            errors.push(`${path}.package: URLs are forbidden`);
          }
          if (
            (source === "brew-formula" || source === "brew-cask") &&
            !/^[A-Za-z0-9@+._/-]+$/.test(item.package)
          ) {
            errors.push(`${path}.package: invalid Homebrew package identifier`);
          }
          if (source === "app-store" && !/^[0-9]+$/.test(item.package)) {
            errors.push(`${path}.package: App Store package must be a numeric id`);
          }
        }
      } else if (
        source === "brew-formula" ||
        source === "brew-cask" ||
        source === "app-store"
      ) {
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

  if (manifest.settings !== undefined) {
    if (!isPlainObject(manifest.settings)) {
      errors.push("$.settings: must be an object");
    } else {
      rejectUnknownKeys(manifest.settings, allowedSettings, "$.settings");

      if (manifest.settings.git !== undefined) {
        if (!isPlainObject(manifest.settings.git)) {
          errors.push("$.settings.git: must be an object");
        } else {
          rejectUnknownKeys(
            manifest.settings.git,
            allowedGit,
            "$.settings.git",
          );

          for (const key of ["userName", "userEmail", "defaultBranch"]) {
            if (manifest.settings.git[key] !== undefined) {
              requireNonEmptyString(
                manifest.settings.git[key],
                `$.settings.git.${key}`,
                200,
              );
            }
          }

          if (
            manifest.settings.git.defaultBranch !== undefined &&
            !/^[A-Za-z0-9._/-]+$/.test(manifest.settings.git.defaultBranch)
          ) {
            errors.push(
              "$.settings.git.defaultBranch: contains unsupported characters",
            );
          }
        }
      }
    }
  }

  if (manifest.manualTasks !== undefined) {
    if (!Array.isArray(manifest.manualTasks)) {
      errors.push("$.manualTasks: must be an array");
    } else {
      manifest.manualTasks.forEach((task, index) => {
        requireNonEmptyString(task, `$.manualTasks[${index}]`, 300);
      });
    }
  }

  return errors;
}
