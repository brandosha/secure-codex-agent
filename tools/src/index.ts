try {
  // @ts-ignore -- This is a dynamic import that may fail if the file doesn't exist, which is expected behavior.
  await import("../config");  
} catch (err) {
  await import("../config.default");
}

export {}; // Required for top-level await to work in this module.