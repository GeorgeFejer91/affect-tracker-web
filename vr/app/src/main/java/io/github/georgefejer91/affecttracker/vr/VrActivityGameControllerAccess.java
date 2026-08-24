package io.github.georgefejer91.affecttracker.vr;

import com.meta.spatial.runtime.VrActivity;
import android.view.InputDevice;
import java.util.Set;

/**
 * Java bridge for VrActivity's public controller registry getter. Spatial SDK 0.13.2 marks the
 * Kotlin property private in metadata even though the JVM getter is public and is part of the AAR.
 */
final class VrActivityGameControllerAccess {
  private VrActivityGameControllerAccess() {}

  static Set<Integer> ids(VrActivity activity) {
    return activity.getGameControllerDeviceIds();
  }

  /** Seeds devices that were connected before VrActivity registered its InputDeviceListener. */
  static Set<Integer> refreshIds(VrActivity activity) {
    Set<Integer> ids = activity.getGameControllerDeviceIds();
    for (int deviceId : InputDevice.getDeviceIds()) {
      InputDevice device = InputDevice.getDevice(deviceId);
      if (device == null) continue;
      int sources = device.getSources();
      boolean gamepad = (sources & InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD;
      boolean joystick = (sources & InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK;
      if (gamepad || joystick) ids.add(deviceId);
    }
    return ids;
  }
}
