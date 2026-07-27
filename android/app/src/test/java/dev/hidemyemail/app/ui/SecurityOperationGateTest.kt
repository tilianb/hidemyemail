package dev.hidemyemail.app.ui

import dev.hidemyemail.app.net.ApiException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SecurityOperationGateTest {
    @Test fun gateRejectsOverlappingOperationsUntilRelease() {
        val gate = SecurityOperationGate()

        assertTrue(gate.tryAcquire())
        assertFalse(gate.tryAcquire())
        gate.release()
        assertTrue(gate.tryAcquire())
    }

    @Test fun dismissedPendingRetryDoesNotMatchCapturedAttempt() {
        val captured = {}

        assertFalse(isCurrentPendingRetry(current = null, captured = captured))
    }

    @Test fun currentPendingRetryMatchesCapturedAttempt() {
        val captured = {}

        assertTrue(isCurrentPendingRetry(current = captured, captured = captured))
    }

    @Test fun unauthorizedIsRoutedInsteadOfDisplayed() {
        var routed = false

        val message = securityErrorMessage(ApiException.Unauthorized()) { routed = true }

        assertTrue(routed)
        assertNull(message)
        assertEquals("Invalid code", securityErrorMessage(ApiException.Server(401, "Invalid code")) {})
    }
}
