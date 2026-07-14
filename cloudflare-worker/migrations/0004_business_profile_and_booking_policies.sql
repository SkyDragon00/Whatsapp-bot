UPDATE settings
SET value = json_set(
	value,
	'$.minimumBookingNoticeMinutes', COALESCE(json_extract(value, '$.minimumBookingNoticeMinutes'), 0),
	'$.maximumAdvanceBookingDays', COALESCE(json_extract(value, '$.maximumAdvanceBookingDays'), 31)
)
WHERE key = 'schedule' AND json_valid(value);

INSERT OR IGNORE INTO settings (key, value)
VALUES (
	'business_profile',
	'{"businessName":null,"preferredTone":null,"greeting":null,"address":null,"contactPhone":null,"cancellationPolicy":null,"arrivalInstructions":null,"generalNotes":null,"acceptedPaymentMethods":[]}'
);
