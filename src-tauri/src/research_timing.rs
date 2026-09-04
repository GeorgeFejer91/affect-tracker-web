use crate::research_error::{CommandError, ResearchResult};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DueSample {
    pub slot: u64,
    pub scheduled_elapsed: Duration,
    pub observed_elapsed: Duration,
    pub lateness: Duration,
    pub jitter_ms: f64,
    pub missed_slots_before: u64,
}

/// A no-catch-up deadline clock. One poll can yield at most one real sample.
/// Deadlines that passed between polls are reported as missed slots and are never synthesized.
#[derive(Debug)]
pub struct DeadlineClock {
    epoch: Instant,
    period: Duration,
    next_slot: u64,
    last_lateness_ms: Option<f64>,
}

impl DeadlineClock {
    pub fn new(rate_hz: u16, epoch: Instant) -> ResearchResult<Self> {
        if !(1..=240).contains(&rate_hz) {
            return Err(CommandError::invalid_contract(
                "The native sampling rate must be within 1–240 Hz.",
            ));
        }
        Ok(Self {
            epoch,
            period: Duration::from_secs_f64(1.0 / f64::from(rate_hz)),
            // Slot 1 is one complete period after stimulus playback starts.  There is
            // deliberately no synthetic sample at the playback-start instant.
            next_slot: 1,
            last_lateness_ms: None,
        })
    }

    pub fn next_deadline(&self) -> Instant {
        self.epoch + self.period.mul_f64(self.next_slot as f64)
    }

    pub fn poll(&mut self, now: Instant) -> Option<DueSample> {
        let deadline = self.next_deadline();
        if now < deadline {
            return None;
        }

        let lateness = now.duration_since(deadline);
        let missed_slots_before =
            (lateness.as_secs_f64() / self.period.as_secs_f64()).floor() as u64;
        let slot = self.next_slot.saturating_add(missed_slots_before);
        let scheduled_elapsed = self.period.mul_f64(slot as f64);
        let observed_elapsed = now.duration_since(self.epoch);
        let emitted_deadline = self.epoch + scheduled_elapsed;
        let emitted_lateness = now.duration_since(emitted_deadline);
        let emitted_lateness_ms = emitted_lateness.as_secs_f64() * 1_000.0;
        // Jitter is signed change in deadline lateness.  This distinguishes a
        // scheduler recovering toward its deadline (negative) from one drifting
        // farther behind (positive).  The first authoritative sample is the origin.
        let jitter_ms = self
            .last_lateness_ms
            .map(|previous| emitted_lateness_ms - previous)
            .unwrap_or(0.0);

        self.next_slot = slot.saturating_add(1);
        self.last_lateness_ms = Some(emitted_lateness_ms);
        Some(DueSample {
            slot,
            scheduled_elapsed,
            observed_elapsed,
            lateness: emitted_lateness,
            jitter_ms,
            missed_slots_before,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emits_one_sample_and_reports_every_missed_slot() {
        let epoch = Instant::now();
        let mut clock = DeadlineClock::new(100, epoch).unwrap();
        assert!(clock.poll(epoch).is_none());
        let first = clock.poll(epoch + Duration::from_millis(10)).unwrap();
        assert_eq!(first.slot, 1);
        assert_eq!(first.missed_slots_before, 0);

        let late = clock.poll(epoch + Duration::from_millis(46)).unwrap();
        assert_eq!(late.slot, 4);
        assert_eq!(late.missed_slots_before, 2);
        assert_eq!(clock.next_deadline(), epoch + Duration::from_millis(50));
    }

    #[test]
    fn never_emits_before_the_next_deadline() {
        let epoch = Instant::now();
        let mut clock = DeadlineClock::new(130, epoch).unwrap();
        assert!(clock.poll(epoch).is_none());
        assert!(clock.poll(epoch + Duration::from_millis(7)).is_none());
    }

    #[test]
    fn first_deadline_and_signed_lateness_delta_are_stable() {
        let epoch = Instant::now();
        let mut clock = DeadlineClock::new(100, epoch).unwrap();

        let first = clock.poll(epoch + Duration::from_millis(12)).unwrap();
        assert_eq!(first.slot, 1);
        assert_eq!(first.scheduled_elapsed, Duration::from_millis(10));
        assert_eq!(first.lateness, Duration::from_millis(2));
        assert_eq!(first.jitter_ms, 0.0);

        let recovering = clock.poll(epoch + Duration::from_millis(21)).unwrap();
        assert_eq!(recovering.slot, 2);
        assert_eq!(recovering.lateness, Duration::from_millis(1));
        assert!((recovering.jitter_ms + 1.0).abs() < 1e-9);

        let drifting = clock.poll(epoch + Duration::from_millis(33)).unwrap();
        assert_eq!(drifting.slot, 3);
        assert_eq!(drifting.lateness, Duration::from_millis(3));
        assert!((drifting.jitter_ms - 2.0).abs() < 1e-9);
    }

    #[test]
    fn rejects_out_of_contract_rates() {
        assert!(DeadlineClock::new(0, Instant::now()).is_err());
        assert!(DeadlineClock::new(241, Instant::now()).is_err());
    }
}
