/**
 * The first lines of every main-world shim that wraps a page function. It stacks a
 * Function.prototype.toString proxy that answers with a wrapper's native source; each script's
 * WeakMap stays in its own closure, and the Proxy delegates to the previous proxy, so wrappers
 * registered by earlier shims are still covered. Do not add properties to a wrapper: a page can
 * see those with getOwnPropertyNames.
 */
export const nativeSourcePreamble = `
  var __nativeToString = Function.prototype.toString;
  var __nativeFakes = new WeakMap();
  var __keepNative = (wrapper, source) => { __nativeFakes.set(wrapper, Function.prototype.toString.call(source)); return wrapper; };
  var __nativeProxy = new Proxy(__nativeToString, {
    apply(target, self, args) {
      var fake = self !== undefined && self !== null ? __nativeFakes.get(self) : undefined;
      return fake || Reflect.apply(target, self, args);
    },
  });
  __nativeFakes.set(__nativeProxy, __nativeToString.call(__nativeToString));
  try { Function.prototype.toString = __nativeProxy; } catch {}
`;
