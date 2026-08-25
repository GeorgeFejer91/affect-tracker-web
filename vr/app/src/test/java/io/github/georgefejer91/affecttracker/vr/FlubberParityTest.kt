package io.github.georgefejer91.affecttracker.vr

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class FlubberParityTest {
  private val fixture = JSONObject(
      requireNotNull(javaClass.getResource("/flubber-golden-v1.json")) { "missing shared golden fixture" }.readText(),
  )

  @Test fun canonicalJavaScriptVerticesAndColorsRemainEquivalent() {
    val tolerance = fixture.getDouble("tolerance").toFloat()
    val cases = fixture.getJSONArray("cases")
    for (caseIndex in 0 until cases.length()) {
      val entry = cases.getJSONObject(caseIndex)
      val geometry = FlubberGeometry(entry.getString("seed"))
      val visual = VisualSettings(
          1.0,
          entry.getDouble("amplitudeScale"),
          entry.getDouble("disorderScale"),
          FlubberBaseShape.entries.first { it.token == entry.optString("baseShape", "circle") },
      )
      val x = entry.getDouble("x").toFloat()
      val y = entry.getDouble("y").toFloat()
      geometry.update(
          AffectSnapshot(x, y, x, y, 0f, 0f, true, false),
          entry.getDouble("phase"),
          visual,
          entry.getBoolean("reducedMotion"),
      )
      val expected = entry.getJSONArray("vertices")
      assertEquals(fixture.getInt("vertexCount"), expected.length())
      for (index in 0 until expected.length()) {
        val vertex = expected.getJSONArray(index)
        assertEquals("${entry.getString("name")} x[$index]", vertex.getDouble(0).toFloat(), geometry.x[index], tolerance)
        assertEquals("${entry.getString("name")} y[$index]", vertex.getDouble(1).toFloat(), geometry.y[index], tolerance)
      }
      val paletteJson = entry.getJSONObject("palette")
      val palette = PaletteSettings(
          paletteJson.getString("up"), paletteJson.getString("down"),
          paletteJson.getString("left"), paletteJson.getString("right"),
      )
      assertEquals(parseRgb(entry.getString("color")), PaletteColor.resolve(x, y, palette))
    }
  }

  @Test fun canonicalJavaScriptSmoothingRemainsEquivalent() {
    val cases = fixture.getJSONArray("smoothing")
    for (index in 0 until cases.length()) {
      val entry = cases.getJSONObject(index)
      assertEquals(
          entry.getDouble("expected").toFloat(),
          smoothToward(
              entry.getDouble("current").toFloat(), entry.getDouble("target").toFloat(),
              entry.getDouble("response"), entry.getDouble("deltaSeconds").toFloat(),
          ),
          0.000001f,
      )
    }
  }

  private fun parseRgb(value: String): Int {
    val channels = Regex("\\d+").findAll(value).map { it.value.toInt() }.toList()
    return 0xff000000.toInt() or (channels[0] shl 16) or (channels[1] shl 8) or channels[2]
  }
}
