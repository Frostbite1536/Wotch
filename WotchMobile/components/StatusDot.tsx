/**
 * Animated status dot — port of the desktop pill's status dot.
 *
 * Matches the desktop CSS animations:
 *   idle/done:  solid green, no animation
 *   thinking:   purple, pulse 1.5s
 *   working:    blue, pulse 2s
 *   waiting:    yellow, pulse 3s
 *   error:      solid red, no animation
 */

import React, { useEffect } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  cancelAnimation,
  Easing,
} from "react-native-reanimated";
import { ClaudeState, STATUS_COLORS, STATUS_PULSE_MS } from "../constants/status";

interface StatusDotProps {
  state: ClaudeState;
  size?: number;
}

export function StatusDot({ state, size = 10 }: StatusDotProps) {
  const opacity = useSharedValue(1);
  const scale = useSharedValue(1);
  const color = STATUS_COLORS[state];
  const pulseMs = STATUS_PULSE_MS[state];

  useEffect(() => {
    cancelAnimation(opacity);
    cancelAnimation(scale);

    if (pulseMs > 0) {
      opacity.value = withRepeat(
        withTiming(0.4, { duration: pulseMs, easing: Easing.inOut(Easing.ease) }),
        -1, // infinite
        true // reverse
      );
      scale.value = withRepeat(
        withTiming(1.3, { duration: pulseMs, easing: Easing.inOut(Easing.ease) }),
        -1,
        true
      );
    } else {
      opacity.value = withTiming(1, { duration: 200 });
      scale.value = withTiming(1, { duration: 200 });
    }
  }, [state, pulseMs]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));

  return (
    <Animated.View
      style={[
        styles.dot,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
          shadowColor: color,
          shadowRadius: size * 0.6,
        },
        animatedStyle,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  dot: {
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    elevation: 4,
  },
});
