# sparkman-fan: SparkMan's fan controller on a Raspberry Pi Pico (MicroPython 1.29+).
#
# Three 4-pin PWM fans on their own 12 V supply, grounds common with the Pico.
# PWM is open-drain: a PIO program only ever pulls the line low or lets go, and the
# fan's own pull-up takes it high, so the Pico never drives a fan input.
# Tach is open-collector, pulled up by the Pico's internal pull-up, 2 pulses per turn.
#
# USB serial, newline-delimited JSON:
#   host -> Pico  {"duty":[40,55,70]}          every second; 0-100 per fan
#                 {"cmd":"maint"}              reboot without the controller, to a free REPL
#                 {"cmd":"tach-test","ch":1,"s":30}  hold that fan's tach line low for s seconds (max 60):
#                                              it reads 0 RPM while still spinning, to test stall alerts
#   Pico -> host  {"rpm":[...],"duty":[...],"fw":"sparkman-fan 0.1.1","failsafe":false}
#                 every second and after each command
# No valid command for 10 s: every fan 100% and "failsafe":true until the next one.
# On boot every fan runs 100%. The hardware watchdog resets a hung Pico, which
# releases the pins, which runs the fans at 100%.

import json, os, select, sys, time
import machine, rp2
from machine import Pin

FW = 'sparkman-fan 0.1.1'
# (PWM pin, tach pin) per fan
FANS = ((21, 20), (22, 19), (16, 17))   # right, middle, left as you face the rack
PERIOD = 2500            # PIO loop counts per PWM period: 2 cycles each at 125 MHz = 25 kHz
WATCHDOG_MS = 10_000
REPORT_MS = 1_000
# a 1,700 RPM fan pulses every ~17 ms; anything much closer is PWM crosstalk on the tach line
TACH_MIN_US = 2_000
MAINT = 'maint.flag'


@rp2.asm_pio(set_init=rp2.PIO.IN_LOW)
def odpwm():
    # x = low counts (the latest from the FIFO, or the last one), isr = period
    pull(noblock)
    mov(x, osr)
    mov(y, isr)
    set(pindirs, 0)          # release: the fan pulls it high
    label('loop')
    jmp(x_not_y, 'skip')
    set(pindirs, 1)          # from here to the end of the period: pull low
    label('skip')
    jmp(y_dec, 'loop')


class Fan:
    def __init__(self, i, pwm, tach):
        self.pwm = pwm
        self.duty = 100
        self.count = 0
        self.last_us = 0
        self.sm = None
        self.tach = Pin(tach, Pin.IN, Pin.PULL_UP)
        self.tach.irq(self._pulse, Pin.IRQ_FALLING)
        self.hold_until = None
        self.i = i
        self.release()

    def _pulse(self, _):
        now = time.ticks_us()
        if time.ticks_diff(now, self.last_us) >= TACH_MIN_US:
            self.count += 1
        self.last_us = now

    def release(self):
        # 100%: no PWM at all, the line floats high
        if self.sm:
            self.sm.active(0)
            self.sm = None
        Pin(self.pwm, Pin.IN)

    def set(self, duty):
        duty = max(0, min(100, int(duty)))
        if duty == self.duty and (self.sm or duty == 100):
            return
        self.duty = duty
        if duty == 100:
            self.release()
            return
        low = PERIOD * (100 - duty) // 100
        if not self.sm:
            self.sm = rp2.StateMachine(self.i, odpwm, freq=125_000_000, set_base=Pin(self.pwm))
            self.sm.put(PERIOD)
            self.sm.exec('pull()')
            self.sm.exec('mov(isr, osr)')
            self.sm.put(low)
            self.sm.active(1)
        else:
            self.sm.put(low)

    def hold_tach(self, ms):
        # pulling the open-collector line low is what the fan does itself on every pulse: no contention
        self.tach.irq(None)
        self.tach.init(Pin.OUT, value=0)
        self.hold_until = time.ticks_add(time.ticks_ms(), ms)

    def release_tach(self):
        self.tach.init(Pin.IN, Pin.PULL_UP)
        self.tach.irq(self._pulse, Pin.IRQ_FALLING)
        self.hold_until = None

    def rpm(self, ms):
        n, self.count = self.count, 0
        return n * 30_000 // ms   # 2 pulses per turn


def main():
    fans = [Fan(i, p, t) for i, (p, t) in enumerate(FANS)]
    wdt = machine.WDT(timeout=8_000)
    poll = select.poll()
    poll.register(sys.stdin, select.POLLIN)
    line = ''
    failsafe = True
    last_cmd = time.ticks_ms()
    last_report = time.ticks_ms()
    rpm = [0, 0, 0]

    def report():
        sys.stdout.write(json.dumps({'rpm': rpm, 'duty': [f.duty for f in fans], 'fw': FW, 'failsafe': failsafe}) + '\n')

    try:
        while True:
            wdt.feed()
            if poll.poll(50):
                ch = sys.stdin.read(1)
                if ch in '\r\n':
                    if line:
                        try:
                            msg = json.loads(line)
                        except ValueError:
                            msg = None
                        if isinstance(msg, dict):
                            d = msg.get('duty')
                            if isinstance(d, list) and len(d) == len(fans) and all(isinstance(x, (int, float)) for x in d):
                                for f, x in zip(fans, d):
                                    f.set(x)
                                failsafe = False
                                last_cmd = time.ticks_ms()
                                report()
                            elif msg.get('cmd') == 'tach-test' and msg.get('ch') in (0, 1, 2):
                                fans[msg['ch']].hold_tach(1000 * max(1, min(60, int(msg.get('s', 30)))))
                            elif msg.get('cmd') == 'maint':
                                for f in fans:
                                    f.release()
                                open(MAINT, 'w').close()
                                machine.reset()
                        line = ''
                elif len(line) < 200:
                    line += ch
            now = time.ticks_ms()
            for f in fans:
                if f.hold_until is not None and time.ticks_diff(now, f.hold_until) >= 0:
                    f.release_tach()
            if not failsafe and time.ticks_diff(now, last_cmd) > WATCHDOG_MS:
                failsafe = True
                for f in fans:
                    f.set(100)
            elapsed = time.ticks_diff(now, last_report)
            if elapsed >= REPORT_MS:
                last_report = now
                rpm = [f.rpm(elapsed) for f in fans]
                report()
    finally:
        # Ctrl-C or a crash: let go of every PWM line (100%)
        for f in fans:
            f.release()
            if f.hold_until is not None:
                f.release_tach()


if MAINT in os.listdir():
    os.remove(MAINT)
    for p, _ in FANS:
        Pin(p, Pin.IN)
    print('sparkman-fan: maintenance boot, controller not started')
else:
    main()
