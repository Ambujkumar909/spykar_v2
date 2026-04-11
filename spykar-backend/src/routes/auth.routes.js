const express = require('express');
const { body } = require('express-validator');
const router = express.Router();
const userRouter = express.Router();
const authController = require('../controllers/auth.controller');
const { authenticate, authorize } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

// POST /api/v1/auth/login
router.post('/login',
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 6 }).withMessage('Password min 6 characters'),
  ],
  validate,
  authController.login
);

// POST /api/v1/auth/refresh
router.post('/refresh',
  [body('refreshToken').notEmpty().withMessage('Refresh token required')],
  validate,
  authController.refresh
);

// POST /api/v1/auth/logout
router.post('/logout', authenticate, authController.logout);

// GET /api/v1/auth/me
router.get('/me', authenticate, authController.me);

// PATCH /api/v1/auth/password
router.patch('/password',
  authenticate,
  [
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword').isLength({ min: 8 }).matches(/^(?=.*[A-Z])(?=.*\d)/).withMessage('New password must be at least 8 characters with one uppercase letter and one number'),
  ],
  validate,
  authController.changePassword
);

userRouter.get('/',
  authenticate,
  authorize('SUPER_ADMIN', 'ADMIN'),
  authController.listUsers
);

userRouter.post('/',
  authenticate,
  authorize('SUPER_ADMIN', 'ADMIN'),
  [
    body('name').trim().isLength({ min: 2 }).withMessage('Name is required'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 8 }).matches(/^(?=.*[A-Z])(?=.*\d)/).withMessage('Password must be 8+ chars with an uppercase letter and number'),
    body('role').isIn(['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'VIEWER']).withMessage('Valid role required'),
    body('zone_id').optional({ nullable: true }).isInt().toInt(),
  ],
  validate,
  authController.createUser
);

userRouter.patch('/:id',
  authenticate,
  authorize('SUPER_ADMIN', 'ADMIN'),
  [
    body('name').optional().trim().isLength({ min: 2 }),
    body('role').optional().isIn(['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'VIEWER']),
    body('is_active').optional().isBoolean(),
    body('zone_id').optional({ nullable: true }).isInt().toInt(),
  ],
  validate,
  authController.updateUser
);

userRouter.patch('/:id/toggle',
  authenticate,
  authorize('SUPER_ADMIN'),
  authController.toggleUser
);

module.exports = { authRouter: router, userRouter };
