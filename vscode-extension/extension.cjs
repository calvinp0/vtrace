let modulePromise;

async function loadModule() {
  if (modulePromise === undefined) {
    modulePromise = import("./extension-main.js");
  }

  return await modulePromise;
}

exports.activate = async function activate(context) {
  const module = await loadModule();
  return await module.activate(context);
};

exports.deactivate = async function deactivate() {
  const module = await loadModule();
  return await module.deactivate();
};
