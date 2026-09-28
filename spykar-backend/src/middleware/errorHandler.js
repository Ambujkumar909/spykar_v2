const logger = require('../config/logger');

class AppError extends Error {
  constructor(message, statusCode = 500, code = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

function errorHandler(err, req, res, next) {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal Server Error';

  // PostgreSQL errors
  if (err.code === '23505') {
    statusCode = 409;
    message = 'A record with this value already exists.';
  } else if (err.code === '23503') {
    statusCode = 400;
    message = 'Referenced record does not exist.';
  } else if (err.code === '23502') {
    statusCode = 400;
    message = `Required field missing: ${err.column}`;
  } else if (['22P02', '22007', '22008', '22003', '22023'].includes(err.code)) {
    // invalid text representation / datetime / out of range: a bad input value
    statusCode = 400;
    message = 'Invalid parameter value.';
  }

  // Log server errors
  if (statusCode >= 500) {
    logger.error('Server Error:', {
      message: err.message,
      stack: err.stack,
      url: req.originalUrl,
      method: req.method,
      user: req.user?.email,
    });
  }

  // In production a genuine server fault never echoes its internal message
  // (SQL text, column names, library errors) back to the browser.
  if (statusCode >= 500 && !err.isOperational && process.env.NODE_ENV === 'production') {
    message = 'Internal Server Error';
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(err.code && { code: err.code }),
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}

function notFound(req, res, next) {
  next(new AppError(`Route ${req.originalUrl} not found`, 404));
}

module.exports = { AppError, errorHandler, notFound };
