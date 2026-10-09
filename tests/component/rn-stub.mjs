// react-native for component tests: host elements named after the component, props passed through.
import React from "react";
const make = (name) => {
  const Component = (props) => React.createElement(name, props, props.children);
  Component.displayName = name;
  return Component;
};
export const Text = make("Text");
export const View = make("View");
export const Pressable = make("Pressable");
export const ActivityIndicator = make("ActivityIndicator");
export const TextInput = make("TextInput");
export const ScrollView = make("ScrollView");
export const Clipboard = { setString: (text) => globalThis.__paseoHost.clipboard(text) };
export const Platform = { OS: "web", select: (options) => options.web ?? options.default };
export const StyleSheet = {
  flatten: (style) => (Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity).filter(Boolean)) : (style ?? {})),
  create: (styles) => styles,
  hairlineWidth: 1,
};
export default { Text, View, Pressable, ActivityIndicator, TextInput, ScrollView, Clipboard, Platform, StyleSheet };
