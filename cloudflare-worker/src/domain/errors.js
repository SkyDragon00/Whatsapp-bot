export class DomainError extends Error {
	constructor(message, code) {
		super(message);
		this.name = new.target.name;
		this.code = code;
	}
}

export class ValidationError extends DomainError {
	constructor(message) {
		super(message, 'VALIDATION_ERROR');
	}
}

export class AppointmentConflictError extends DomainError {
	constructor(message = 'El horario solicitado ya no está disponible.') {
		super(message, 'APPOINTMENT_CONFLICT');
	}
}

export class AppointmentNotFoundError extends DomainError {
	constructor(message = 'No se encontró la cita.') {
		super(message, 'APPOINTMENT_NOT_FOUND');
	}
}

export class AppointmentOwnershipError extends DomainError {
	constructor(message = 'La cita no pertenece a este usuario.') {
		super(message, 'APPOINTMENT_OWNERSHIP_ERROR');
	}
}

export class AiProtocolError extends DomainError {
	constructor(message = 'La respuesta del modelo no es válida.') {
		super(message, 'AI_PROTOCOL_ERROR');
	}
}
